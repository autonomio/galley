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
}

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
  try {
    return await scan(paper, behaviors, options, log)
  } finally {
    clearInterval(heartbeat)
    paper.writeProgress()
  }
}

async function scan(paper: Paper, behaviors: Behavior[], options: RunOptions, log: (line: string) => void): Promise<string | undefined> {
  // Background targets run alongside the scan; the paper waits for them only when nothing else is ready.
  const background = new Map<string, Promise<void>>()
  let failure: unknown = null
  for (;;) {
    let progressed = false
    for (const behavior of behaviors) {
      if (paper.config.off.includes(behavior.id)) continue
      const targets = behavior.ready(paper).filter((t) => !paper.isSettled(t.key) && !background.has(t.key))
      for (const target of targets.filter((t) => t.background)) {
        background.set(target.key, runTarget(paper, behavior, target, log).catch((error) => { failure ??= error }).finally(() => background.delete(target.key)))
      }
      const now = targets.filter((t) => !t.background)
      if (!now.length) continue
      progressed = true
      await Promise.all(now.map((target) => runTarget(paper, behavior, target, log)))
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
