// A paper on disk: its seed, its state, its journal and every model call it
// made. Writes are atomic, so a run that dies resumes from the last settled step.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig, specFor, type PaperConfig } from './config.js'
import { callModel, ModelFailure, RateLimited, resetHintMs, type CallResult } from './models.js'
import type { Schema } from './schema.js'
import type { Family, Note, PaperState, Seat } from './types.js'

const LIMITS: Record<Family, number> = { claude: 4, gpt: 4, gemini: 3 }
const active: Record<Family, number> = { claude: 0, gpt: 0, gemini: 0 }
const waiting: Record<Family, (() => void)[]> = { claude: [], gpt: [], gemini: [] }

async function acquire(family: Family): Promise<void> {
  if (active[family] < LIMITS[family]) { active[family]++; return }
  await new Promise<void>((resolve) => waiting[family].push(resolve))
  active[family]++
}

function release(family: Family): void {
  active[family]--
  waiting[family].shift()?.()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// A subscription's usage window can last five hours: an unattended run waits it out (about six hours in all) rather than stopping for a person to restart it.
const LIMIT_WAITS = [60_000, 3 * 60_000, 10 * 60_000, 20 * 60_000, ...Array<number>(11).fill(30 * 60_000)]
const LIMIT_HINT_CAP = 3 * 3_600_000

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n')
  renameSync(temp, path)
}

export interface AskOptions {
  behavior: string
  target: string
  seat: Seat | string
  family: Family
  prompt: string
  schema: Schema
  effort?: string
}

/** A model call or search in flight, for heartbeats and `galley status`. */
export interface InFlight {
  behavior: string
  target: string
  what: string
  started: number
}

export class Paper {
  readonly dir: string
  state: PaperState
  config: PaperConfig
  /** The behaviors this run executes, in ladder order; set by the scheduler, so the paper can describe its own production. */
  ladder: { id: string; stage: string; improver: boolean; title: string }[] = []
  private callSeq = 0
  /** Where progress lines go while a run is going; silent outside a run. */
  say: (line: string) => void = () => {}
  readonly inFlight = new Map<number, InFlight>()
  private flightSeq = 0

  /** Mark work as in flight until the returned function is called. */
  begin(entry: Omit<InFlight, 'started'>): () => void {
    const id = ++this.flightSeq
    this.inFlight.set(id, { ...entry, started: Date.now() })
    this.writeProgress()
    return () => { this.inFlight.delete(id); this.writeProgress() }
  }

  /** progress.json: what is in flight right now and what settled last, for anyone watching. */
  writeProgress(): void {
    const settled = Object.keys(this.state.settled)
    try {
      writeJsonAtomic(this.path('progress.json'), {
        at: new Date().toISOString(),
        pid: process.pid,
        outcome: this.state.outcome ?? null,
        inFlight: [...this.inFlight.values()].map((f) => ({ ...f, started: new Date(f.started).toISOString(), seconds: Math.round((Date.now() - f.started) / 1000) })),
        settled: settled.length,
        lastSettled: settled.slice(-5),
      })
    } catch { /* progress is a courtesy; never fail a run over it */ }
  }

  private constructor(dir: string, state: PaperState, config: PaperConfig) {
    this.dir = dir
    this.state = state
    this.config = config
  }

  static create(dir: string, seed: string, overrides: Partial<PaperConfig> = {}): Paper {
    mkdirSync(dir, { recursive: true })
    if (existsSync(join(dir, 'state.json'))) throw new Error(`${dir} already holds a paper`)
    const slug = dir.split('/').filter(Boolean).pop()!
    writeFileSync(join(dir, 'seed.md'), seed.endsWith('\n') ? seed : seed + '\n')
    if (!existsSync(join(dir, 'paper.json'))) writeJsonAtomic(join(dir, 'paper.json'), overrides)
    const state: PaperState = {
      version: 1,
      slug,
      createdAt: new Date().toISOString(),
      seed: { text: seed, sha256: sha256(seed) },
      claims: [],
      positioning: {},
      directions: [],
      works: {},
      candidates: [],
      citations: [],
      passages: {},
      figures: [],
      findings: [],
      round: 0,
      settled: {},
      attempts: {},
      notes: [],
    }
    const paper = new Paper(dir, state, Paper.readConfig(dir))
    paper.save()
    paper.journal({ event: 'created', seed_sha256: state.seed.sha256 })
    return paper
  }

  static open(dir: string): Paper {
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as PaperState
    return new Paper(dir, state, Paper.readConfig(dir))
  }

  static readConfig(dir: string): PaperConfig {
    const path = join(dir, 'paper.json')
    const overrides = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    const base = defaultConfig()
    return { ...base, ...overrides, seats: { ...base.seats, ...(overrides.seats || {}) } }
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts)
  }

  save(): void {
    writeJsonAtomic(this.path('state.json'), this.state)
  }

  journal(entry: Record<string, unknown>): void {
    appendFileSync(this.path('journal.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  }

  note(behavior: string, text: string, forHuman = false): void {
    const note: Note = { at: new Date().toISOString(), behavior, text, ...(forHuman ? { forHuman } : {}) }
    this.state.notes.push(note)
    this.journal({ event: 'note', behavior, text, forHuman })
    this.save()
  }

  isSettled(key: string): boolean {
    return key in this.state.settled
  }

  settle(key: string, how: 'done' | 'skipped'): void {
    this.state.settled[key] = how
    this.save()
  }

  /** Ask one family for one structured answer, within its concurrency limit, waiting out provider limits. */
  async ask<T = any>(options: AskOptions): Promise<T> {
    const spec = { ...specFor(this.config, options.family), ...(options.effort ? { effort: options.effort } : {}) }
    const seq = ++this.callSeq
    const file = `${String(Date.now()).slice(-9)}-${seq}-${options.behavior}-${options.family}.json`
    for (let wait = 0; ; wait++) {
      await acquire(options.family)
      let result: CallResult
      const done = this.begin({ behavior: options.behavior, target: options.target, what: `${spec.model} (${options.seat})` })
      try {
        result = await callModel({ spec, prompt: options.prompt, schema: options.schema, cacheDir: this.path('calls', 'cache') })
      } catch (error) {
        done()
        release(options.family)
        if (error instanceof RateLimited && wait < LIMIT_WAITS.length) {
          // A provider that says when its quota resets is tried again just after that, not on the fixed schedule.
          const hint = resetHintMs(error.message)
          const ms = hint === null ? LIMIT_WAITS[wait] : Math.min(hint + 30_000, LIMIT_HINT_CAP)
          this.journal({ event: 'provider_limit', behavior: options.behavior, target: options.target, family: options.family, wait_ms: ms, message: error.message })
          this.say(`… ${options.behavior}: ${options.family} is at a usage limit or out of reach; waiting ${Math.max(1, Math.round(ms / 60_000))} min (${error.message.slice(0, 120)})`)
          await sleep(ms)
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        mkdirSync(this.path('calls'), { recursive: true })
        writeJsonAtomic(this.path('calls', file), { behavior: options.behavior, target: options.target, seat: options.seat, spec, prompt: options.prompt, error: message })
        this.journal({ event: 'call_failed', behavior: options.behavior, target: options.target, seat: options.seat, family: options.family, model: spec.model, error: message, call: file })
        throw error instanceof ModelFailure || error instanceof RateLimited ? error : new ModelFailure(message)
      }
      done()
      release(options.family)
      mkdirSync(this.path('calls'), { recursive: true })
      writeJsonAtomic(this.path('calls', file), {
        behavior: options.behavior, target: options.target, seat: options.seat, spec,
        prompt: options.prompt, output: result.data, usage: result.usage, ms: result.ms, cached: result.cached,
      })
      this.journal({
        event: 'call', behavior: options.behavior, target: options.target, seat: options.seat, family: options.family,
        model: spec.model, effort: spec.effort, ms: result.ms, cached: result.cached, usage: result.usage, call: file,
      })
      return result.data as T
    }
  }
}
