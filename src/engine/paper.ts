// A paper on disk: its seed, its state, its journal and every model call it
// made. Writes are atomic, so a run that dies resumes from the last settled step.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyFamilies, defaultConfig, familiesOn, lightSpecFor, specFor, type PaperConfig } from './config.js'
import { isSoftwareRole, SOFTWARE_ROLE_HINT, SOFTWARE_SUBJECT_HINT, softwareSubject, type SoftwareRole } from '../core/software-subject.js'
import { adjudicatorModel, modelForPlace, modelSpec, readModelCatalog, resolveRouting, restrictRouting, specIdentity, SLOTS, type CatalogModel, type Place } from './model-catalog.js'
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
  referee?: string
  assignedModel?: CatalogModel
  /** Legacy papers settle single referee findings on their lighter settings. */
  light?: boolean
  /** Image files to look at, such as typeset pages: GPT reads them; the prompt carries their text for the other families. */
  images?: string[]
  /** Let the model search the web; only GPT's calls can. */
  web?: boolean
}

/** A model call or search in flight, for heartbeats and `galley status`. */
export interface InFlight {
  behavior: string
  target: string
  what: string
  started: number
  family?: Family
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
    if (this.softwareRole === 'introduction') {
      if (config.literatureReview === 'load-bearing') config.literatureReview = true
      if (config.simulation === 'load-bearing') config.simulation = true
    }
  }

  get softwareRole(): SoftwareRole | undefined {
    return this.state.softwareSubject ? this.state.softwareRole ?? 'introduction' : undefined
  }

  static create(dir: string, seed: string, overrides: Partial<PaperConfig> = {}): Paper {
    if (existsSync(join(dir, 'state.json'))) throw new Error(`${dir} already holds a paper`)
    const configPath = join(dir, 'paper.json')
    const hasConfig = existsSync(configPath)
    const config = hasConfig ? JSON.parse(readFileSync(configPath, 'utf8')) as Partial<PaperConfig> : overrides
    const commitLink = overrides.softwareCommit ?? config.softwareCommit
    const subject = commitLink ? softwareSubject(commitLink) : null
    if (commitLink && !subject) throw new Error(SOFTWARE_SUBJECT_HINT)
    const softwareRole = overrides.softwareRole ?? config.softwareRole
    if (softwareRole !== undefined && (!subject || !isSoftwareRole(softwareRole))) throw new Error(SOFTWARE_ROLE_HINT)
    const legacy = config.seats || config.models || config.lightModels || config.referees
    const routing = overrides.routing ?? config.routing ?? (legacy ? undefined : resolveRouting(readModelCatalog()))
    if (routing) restrictRouting(routing, config.families)
    mkdirSync(dir, { recursive: true })
    if (!hasConfig || (!config.routing && routing) || overrides.routing) writeJsonAtomic(configPath, { ...config, routing })
    const slug = dir.split('/').filter(Boolean).pop()!
    writeFileSync(join(dir, 'seed.md'), seed.endsWith('\n') ? seed : seed + '\n')
    const state: PaperState = {
      version: 1,
      slug,
      createdAt: new Date().toISOString(),
      seed: { text: seed, sha256: sha256(seed) },
      ...(subject ? { softwareSubject: subject, softwareRole: softwareRole ?? 'introduction' } : {}),
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
    // An earlier engine marked a finding "noted" when its referee still disagreed. No finding is dropped now, so in a
    // paper that is still being worked on such a finding is open again, for escalation, adjudication or a stated
    // limitation to settle. A finding a person set aside stays theirs.
    if (!state.outcome || state.outcome === 'ready_for_submission' || state.outcome === 'finished_with_open_defects') {
      for (const f of state.findings ?? []) if (f.status === 'noted' && f.assignee !== 'humans') f.status = 'open'
    }
    // An earlier engine sent a figure back to be drawn again under its first drawing's step, which was settled, so it
    // was never drawn and the paper could not be typeset again. Such a figure is now a redraw of its own.
    for (const fig of state.figures ?? []) {
      if (fig.status === 'planned' && fig.revise && !fig.redraws && `figure:${fig.id}` in (state.settled ?? {})) fig.redraws = 1
    }
    const paper = new Paper(dir, state, Paper.readConfig(dir))
    // A saved chart awaiting a disabled renderer must not hold the frame or typesetting; a previous drawing still prints.
    if (paper.config.off.includes('story-charts') || paper.config.off.includes('story')) {
      for (const fig of state.figures ?? []) if (fig.kind === 'chart' && fig.status === 'planned') fig.status = fig.file ? 'rendered' : 'skipped'
    }
    return paper
  }

  static readConfig(dir: string): PaperConfig {
    const path = join(dir, 'paper.json')
    const overrides: Partial<PaperConfig> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    const base = defaultConfig()
    // The seats follow the families the paper may use.
    const config = { ...base, ...overrides, seats: { ...base.seats, ...overrides.seats } }
    if (config.routing) {
      config.routing = restrictRouting(config.routing, config.families)
      const routing = config.routing
      for (const seat of Object.keys(config.seats) as (keyof PaperConfig['seats'])[]) {
        config.seats[seat] = modelSpec(modelForPlace(routing, seat)).family
      }
      config.referees = config.referees.map((r) => ({ ...r, family: modelSpec(modelForPlace(routing, r.seat as Place)).family }))
    } else {
      Object.assign(config, applyFamilies(config))
    }
    // A paper that rests only on its world model searches nothing else: no systematic review, no sources from the web.
    if (config.worldModel && config.worldModel.only !== false) { config.literatureReview = false; config.webSources = false }
    return config
  }

  /**
   * A change of model families in paper.json (from the project's settings) takes effect at the next step of a running
   * paper: the seats are dealt again for the families now on. Returns whether anything changed.
   */
  refreshFamilies(): boolean {
    const path = this.path('paper.json')
    if (!existsSync(path)) return false
    let families: Family[] | undefined
    try { families = JSON.parse(readFileSync(path, 'utf8')).families } catch { return false }
    if (JSON.stringify(familiesOn({ families })) === JSON.stringify(familiesOn(this.config))) return false
    const fresh = Paper.readConfig(this.dir)
    this.config = { ...this.config, families: fresh.families, seats: fresh.seats, referees: fresh.referees, routing: fresh.routing }
    this.journal({ event: 'families', families: familiesOn(this.config), seats: this.config.seats })
    this.say(`Models now: ${familiesOn(this.config).join(', ')}; ${Object.entries(this.config.seats).map(([seat, f]) => `${seat} ${f}`).join(', ')}`)
    return true
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

  webModel(): ReturnType<typeof specFor> | undefined {
    const { routing } = this.config
    if (!routing) return familiesOn(this.config).includes('gpt') ? specFor(this.config, 'gpt') : undefined
    const checker = modelForPlace(routing, 'checker')
    if (checker.provider === 'codex') return modelSpec(checker)
    const slot = (routing.enabled ?? SLOTS).find((key) => routing.slots[key].provider === 'codex')
    return slot ? modelSpec(routing.slots[slot]) : undefined
  }

  modelFor(options: Pick<AskOptions, 'seat' | 'family' | 'light' | 'referee' | 'assignedModel' | 'web'>): ReturnType<typeof specFor> {
    const { routing } = this.config
    if (options.web) {
      const spec = this.webModel()
      if (!spec) throw new ModelFailure('Web search needs a configured GPT model.')
      return spec
    }
    if (options.assignedModel) return modelSpec(options.assignedModel)
    if (!routing) return options.light ? lightSpecFor(this.config, options.family) : specFor(this.config, options.family)
    const place = (options.referee ?? options.seat.replace(/^referee:/, '')) as Place
    if (options.seat === 'adjudicator') {
      const referee = options.referee === 'human' ? modelForPlace(routing, 'challenger') : modelForPlace(routing, place)
      return modelSpec(adjudicatorModel(routing, referee))
    }
    return modelSpec(modelForPlace(routing, place))
  }

  /** Ask one family for one structured answer, within its concurrency limit, waiting out provider limits. */
  async ask<T = any>(options: AskOptions): Promise<T> {
    const spec = this.modelFor(options)
    const { family } = spec
    const seq = ++this.callSeq
    const file = `${String(Date.now()).slice(-9)}-${seq}-${options.behavior}-${family}.json`
    for (let wait = 0; ; wait++) {
      await acquire(family)
      let result: CallResult
      const done = this.begin({ behavior: options.behavior, target: options.target, what: `${specIdentity(spec)} (${options.seat})`, family })
      try {
        result = await callModel({ spec, prompt: options.prompt, schema: options.schema, images: options.images, web: options.web, cacheDir: this.path('calls', 'cache') })
      } catch (error) {
        done()
        release(family)
        if (error instanceof RateLimited && wait < LIMIT_WAITS.length) {
          // A provider that says when its quota resets is tried again just after that, not on the fixed schedule.
          const hint = resetHintMs(error.message)
          const ms = hint === null ? LIMIT_WAITS[wait] : Math.min(hint + 30_000, LIMIT_HINT_CAP)
          this.journal({ event: 'provider_limit', behavior: options.behavior, target: options.target, family, identity: specIdentity(spec), wait_ms: ms, message: error.message })
          this.say(`… ${options.behavior}: ${specIdentity(spec)} is at a usage limit or out of reach; waiting ${Math.max(1, Math.round(ms / 60_000))} min (${error.message.slice(0, 120)})`)
          await sleep(ms)
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        mkdirSync(this.path('calls'), { recursive: true })
        writeJsonAtomic(this.path('calls', file), { behavior: options.behavior, target: options.target, seat: options.seat, spec, prompt: options.prompt, error: message })
        this.journal({ event: 'call_failed', behavior: options.behavior, target: options.target, seat: options.seat, family, model: spec.model, effort: spec.effort, error: message, call: file })
        throw error instanceof ModelFailure || error instanceof RateLimited ? error : new ModelFailure(message)
      }
      done()
      release(family)
      mkdirSync(this.path('calls'), { recursive: true })
      writeJsonAtomic(this.path('calls', file), {
        behavior: options.behavior, target: options.target, seat: options.seat, spec,
        prompt: options.prompt, output: result.data, usage: result.usage, ms: result.ms, cached: result.cached,
        ...(result.delivery ? { delivery: result.delivery } : {}),
      })
      this.journal({
        event: 'call', behavior: options.behavior, target: options.target, seat: options.seat, family,
        model: spec.model, effort: spec.effort, ms: result.ms, cached: result.cached, usage: result.usage, call: file,
      })
      return result.data as T
    }
  }
}
