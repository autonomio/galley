// The scheduler picks the next work from what the paper's state shows, never
// from what ran before. Behaviors are listed in ladder order; after any work
// settles, the scan starts again from the top, so every behavior reacts to the
// newest state. Improvers can fail without stopping the line: a target that
// fails twice is settled as skipped, with a note, and the paper moves on.
import { ModelFailure, RateLimited } from './models.js'
import type { Paper } from './paper.js'

export interface Target {
  /** Unique and stable: the same work always has the same key. */
  key: string
  label: string
  run: () => Promise<void>
  /** What giving up on this target means for the state, so nothing waits on it forever. */
  skip?: () => void
  /** Long work outside the models (a Canary review): it runs alongside the rest of the paper instead of holding it up. */
  background?: boolean
}

export interface Behavior {
  id: string
  stage: 'skeleton' | 'truth' | 'aim' | 'substance' | 'manuscript' | 'referees' | 'close'
  /** False only for the skeleton, which must succeed for a paper to exist at all. */
  improver: boolean
  title: string
  /** How many times a target may fail before it is given up; defaults to 2 for an improver, 3 for the skeleton. */
  attempts?: number
  ready(paper: Paper): Target[]
}

export class Stalled extends Error {}

export interface RunOptions {
  /** Stop after this behavior has settled (for proving one rung at a time). */
  until?: string
  log?: (line: string) => void
  /**
   * Keep the editor's copy in step: take in what a person changed there, and
   * write what the paper now says. Called after every settled target and every
   * few seconds while work is in flight, so the paper grows in the editor.
   */
  sync?: (paper: Paper) => void
}

const SYNC_EVERY_MS = 8_000

async function runTarget(paper: Paper, behavior: Behavior, target: Target, log: (line: string) => void): Promise<void> {
  const limit = behavior.attempts ?? (behavior.improver ? 2 : 3)
  for (;;) {
    const attempt = (paper.state.attempts[target.key] ?? 0) + 1
    paper.state.attempts[target.key] = attempt
    paper.save()
    const started = Date.now()
    log(`▸ ${behavior.id}: ${target.label}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
    try {
      await target.run()
      if (!paper.isSettled(target.key)) paper.settle(target.key, 'done')
      paper.journal({ event: 'settled', behavior: behavior.id, target: target.key, how: paper.state.settled[target.key], ms: Date.now() - started })
      log(`✓ ${behavior.id}: ${target.label} (${Math.round((Date.now() - started) / 1000)}s)`)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      paper.journal({ event: 'failed', behavior: behavior.id, target: target.key, attempt, error: message })
      log(`✗ ${behavior.id}: ${target.label}: ${message.slice(0, 300)}`)
      if (error instanceof RateLimited) {
        // An outage is not the work failing: it does not use up an attempt.
        paper.state.attempts[target.key] = attempt - 1
        paper.save()
        throw new Stalled(`provider limits did not clear: ${message}`)
      }
      if (attempt < limit) {
        // A model that just failed gets a moment before the next attempt, so one bad minute does not use up every attempt.
        if (error instanceof ModelFailure) await new Promise((resolve) => setTimeout(resolve, attempt * 30_000))
        continue
      }
      if (!behavior.improver) throw new Stalled(`${behavior.id} failed ${attempt} times on ${target.label}: ${message}`)
      target.skip?.()
      paper.settle(target.key, 'skipped')
      paper.note(behavior.id, `${target.label} was skipped after ${attempt} attempts: ${message.slice(0, 300)}`)
      return
    }
  }
}

const elapsed = (ms: number) => ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`

/** Run every ready behavior until nothing is ready. Returns the paper's outcome, if it reached one. */
export async function runPaper(paper: Paper, behaviors: Behavior[], options: RunOptions = {}): Promise<string | undefined> {
  const log = options.log ?? ((line: string) => console.log(line))
  paper.say = log
  paper.ladder = behaviors.map(({ id, stage, improver, title }) => ({ id, stage, improver, title }))
  // The editor's copy is a convenience: keeping it in step never stops a paper.
  const sync = () => {
    if (!options.sync) return
    try { options.sync(paper) } catch (error) { log(`… the editor copy was not synced: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`) }
  }
  // A heartbeat: every minute, say what is in flight and for how long, so a long call is never a silent wait.
  const heartbeat = setInterval(() => {
    paper.writeProgress()
    for (const f of paper.inFlight.values()) {
      const items = f.target.split(',')
      const target = items.length > 3 ? `${items.slice(0, 2).join(',')} and ${items.length - 2} more` : f.target
      log(`… ${f.behavior} ${target}: ${f.what}, ${elapsed(Date.now() - f.started)} so far`)
    }
  }, 60_000)
  heartbeat.unref()
  // A model call can take minutes; a person's note or edit is taken in meanwhile, not when it returns.
  const syncing = options.sync ? setInterval(sync, SYNC_EVERY_MS) : null
  syncing?.unref()
  try {
    return await scan(paper, behaviors, options, log, sync)
  } finally {
    clearInterval(heartbeat)
    if (syncing) clearInterval(syncing)
    paper.writeProgress()
    sync()
  }
}

async function scan(paper: Paper, behaviors: Behavior[], options: RunOptions, log: (line: string) => void, sync: () => void): Promise<string | undefined> {
  // Background targets run alongside the scan; the paper waits for them only when nothing else is ready.
  const background = new Map<string, Promise<void>>()
  let failure: unknown = null
  for (;;) {
    // What a person changed in the editor is state like any other: the next behavior sees it.
    sync()
    // So is a change of model families in the project's settings: the next call goes to the seats dealt for them.
    paper.refreshFamilies()
    let progressed = false
    for (const behavior of behaviors) {
      if (paper.config.off.includes(behavior.id)) continue
      const targets = behavior.ready(paper).filter((t) => !paper.isSettled(t.key) && !background.has(t.key))
      for (const target of targets.filter((t) => t.background)) {
        background.set(target.key, runTarget(paper, behavior, target, log).catch((error) => { failure ??= error }).finally(() => { background.delete(target.key); sync() }))
      }
      const now = targets.filter((t) => !t.background)
      if (!now.length) continue
      progressed = true
      // Each target lands in the editor as it settles, not when the slowest of its batch does.
      await Promise.all(now.map((target) => runTarget(paper, behavior, target, log).then(sync)))
      if (options.until === behavior.id) return paper.state.outcome
      break
    }
    if (failure) throw failure
    if (!progressed) {
      if (!background.size) return paper.state.outcome
      await Promise.race(background.values())
    }
  }
}

export { ModelFailure }
