// What a host shows while a paper is being written, read from the paper's own
// files and never touching the run: who is working right now and on what, where
// the paper stands, its working notes, and what has happened, in the words a
// person reads. A host polls it beside the editor; the editor's copy carries
// the text and the threads themselves.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { modelForPlace, type Place } from './model-catalog.js'
import { Paper } from './paper.js'
import { FAMILY_NAMES } from './config.js'
import type { Family, PaperState } from './types.js'

export interface LiveSeat {
  /** author, checker, challenger, verifier, adjudicator, or a referee's seat such as methods. */
  seat: string
  name: string
  family: Family | null
  model: string
  doing: string
  /** The section the work is on, when it is on one. */
  section: string | null
  /** The finding the work answers or judges, when it does. */
  finding: string | null
  seconds: number
}

export interface LiveEntry {
  at: string
  seat: string
  name: string
  family: Family | null
  text: string
  stage: string
  section?: string
  finding?: string
  human?: boolean
}

export interface WorkingNote {
  key: string
  label: string
  text: string
  seat: string
  family: Family | null
}

export interface LiveView {
  slug: string
  /** The editor document the paper is written into. */
  doc: string
  title: string
  running: boolean
  outcome: string | null
  stage: { id: string, label: string }
  stages: { id: string, label: string, done: boolean }[]
  /** Everyone at work on the paper, in a stable order, with the family behind each seat when known. */
  team: { seat: string, name: string, family: Family | null, detail: string | null }[]
  /** The outline, once there is one: where a seat's work lands in the document. */
  sections: { id: string, title: string, written: boolean }[]
  now: LiveSeat[]
  waiting: { family: Family, name: string, until: string } | null
  notes: WorkingNote[]
  activity: LiveEntry[]
}

const SEATS: Record<string, string> = { author: 'Author', checker: 'Checker', challenger: 'Challenger', verifier: 'Verifier', adjudicator: 'Adjudicator', referee: 'Referee', human: 'You', galley: 'Galley' }
const seatName = (seat: string) => SEATS[seat] ?? `${seat.charAt(0).toUpperCase()}${seat.slice(1)} referee`
const familyOf = (model: string): Family | null => model.startsWith('claude') ? 'claude' : model.startsWith('gpt') ? 'gpt' : model.startsWith('gemini') ? 'gemini' : null

// Which seat does a behavior's work, for the activity line.
const WORKS: Record<string, string> = {
  extract: 'author', plan: 'author', outline: 'author', draft: 'author', figure: 'author', frame: 'author', respond: 'author', analyze: 'author', simulate: 'author',
  position: 'checker', 'select-direction': 'checker', 'find-evidence': 'checker', fidelity: 'checker', reconcile: 'checker',
  'review-idea': 'challenger', reformulate: 'challenger', reprofile: 'challenger', reassess: 'challenger',
  verify: 'verifier', calibrate: 'verifier', adjudicate: 'adjudicator', 'verify-disposition': 'referee',
}
const STAGE_OF: Record<string, string> = {
  extract: 'aim', position: 'aim', 'review-idea': 'aim', reformulate: 'aim', 'select-direction': 'aim',
  'literature-review': 'substance', analyze: 'substance', simulate: 'substance',
  plan: 'plan', outline: 'plan',
  'find-evidence': 'evidence', verify: 'evidence', reassess: 'evidence', calibrate: 'evidence',
  draft: 'draft', figure: 'draft', fidelity: 'draft', frame: 'draft',
  referee: 'review', respond: 'review', 'verify-disposition': 'review', adjudicate: 'review', 'close-round': 'review',
  reconcile: 'finish', reprofile: 'finish', typeset: 'finish', ready: 'finish',
}
const STAGE_ORDER = ['seed', 'aim', 'substance', 'plan', 'evidence', 'draft', 'review', 'finish']
const STAGE_LABEL: Record<string, string> = { seed: 'Seed', aim: 'Aim', substance: 'Materials', plan: 'Plan', evidence: 'Evidence', draft: 'Draft', review: 'Review', finish: 'Finish' }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const editorSlug = (slug: string) => slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-')

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return null }
}

/** Where work lands in the paper: its section, and the finding it is about. */
function placeOf(s: PaperState, behavior: string, target: string): { section: string | null, finding: string | null } {
  const ids = target.replace(/^[a-z-]+:/, '').split(',').map((x) => x.replace(/\.\d+$/, ''))
  const first = ids[0] ?? ''
  if (/^S\d+$/.test(first)) return { section: first, finding: null }
  if (/^(F\d|H-)/.test(first)) return { section: s.findings.find((f) => f.id === first)?.sectionId ?? null, finding: first }
  const claimId = /^K\d+$/.test(first) ? s.citations.find((c) => c.id === first)?.claimId : /^C\d+$/.test(first) ? first : null
  if (claimId) return { section: s.outline?.sections.find((sec) => sec.claimIds.includes(claimId))?.id ?? null, finding: null }
  if (behavior === 'figure') return { section: s.figures.find((f) => f.id === first)?.sectionId ?? null, finding: null }
  return { section: null, finding: null }
}

function doing(s: PaperState, behavior: string, target: string): string {
  const ids = target.replace(/^[a-z-]+:/, '').split(',').filter(Boolean)
  const title = (id: string) => s.outline?.sections.find((sec) => sec.id === id)?.title ?? id
  switch (behavior) {
    case 'extract': return 'reading your seed'
    case 'position': return 'placing the idea among prior work'
    case 'review-idea': return 'scoring the idea on seven impact factors'
    case 'reformulate': return 'reframing the idea three ways'
    case 'select-direction': return 'choosing a direction'
    case 'literature-review': return 'running the systematic review with Canary'
    case 'analyze': return 'measuring your data'
    case 'simulate': return 'designing and running the simulation'
    case 'plan': return 'planning the argument'
    case 'outline': return 'outlining the sections'
    case 'find-evidence': return `searching for sources for ${ids.length > 2 ? plural(ids.length, 'claim') : ids.join(', ')}`
    case 'verify': return `checking ${plural(ids.length, 'citation')} against their passages`
    case 'reassess': return 'reassessing the thesis'
    case 'calibrate': return 'testing the verifier with planted defects'
    case 'draft': return `drafting ${title(ids[0])}`
    case 'figure': return `drawing ${ids[0]}`
    case 'fidelity': return `checking ${title(ids[0])} against its claims`
    case 'frame': return 'writing the title and abstract'
    case 'referee': return 'reviewing the whole manuscript'
    case 'respond': return `answering ${ids.length > 1 ? plural(ids.length, 'finding') : ids[0]?.replace(/\.\d+$/, '')}`
    case 'verify-disposition': return `judging ${plural(ids.length, 'answer')}`
    case 'adjudicate': return `settling ${ids[0]}`
    case 'reconcile': return 'reading the final text against every claim'
    case 'reprofile': return 'profiling the finished paper'
    case 'typeset': return 'typesetting'
    default: return behavior
  }
}

interface JournalEvent { at: string, event: string, [key: string]: any }

/** The journal as sentences, oldest first. */
/** The journal as sentences, oldest first. Each reads after its actor's name: "Author drafted Introduction." */
function activity(s: PaperState, events: JournalEvent[]): LiveEntry[] {
  const out: LiveEntry[] = []
  const lastFamily: Record<string, Family> = {}
  let stage = 'seed'
  let frames = 0
  const say = (e: JournalEvent, seat: string, text: string, extra: Partial<LiveEntry> = {}) =>
    out.push({ at: e.at, seat, name: seatName(seat), family: extra.family ?? (seat === 'human' || seat === 'galley' ? null : lastFamily[seat] ?? null), text, stage, ...extra })
  const sectionTitle = (id: string) => s.outline?.sections.find((sec) => sec.id === id)?.title ?? id
  for (const e of events) {
    if (e.event === 'call') {
      const seat = String(e.seat ?? '').replace(/^referee:.*/, 'referee')
      if (e.family) lastFamily[WORKS[e.behavior] ?? seat] = e.family
      continue
    }
    if (e.event === 'created') { say(e, 'human', 'started the paper from your seed.', { human: true }); continue }
    if (e.event === 'human_edits') { say(e, 'human', `edited ${(e.sections as string[]).map((x) => x === 'title' || x === 'abstract' ? `the ${x}` : sectionTitle(x)).join(', ')}.`, { human: true }); continue }
    if (e.event === 'review') {
      stage = 'review'
      say(e, String(e.seat), `reviewed the manuscript: ${String(e.verdict ?? '').replace(/_/g, ' ')}.`, { family: e.family ?? null })
      continue
    }
    if (e.event === 'provider_limit') {
      const family = e.family as Family
      say(e, 'galley', `is waiting out ${e.identity ?? FAMILY_NAMES[family] ?? family}'s usage limit (${Math.max(1, Math.round(Number(e.wait_ms) / 60000))} min), then carries on.`)
      continue
    }
    if (e.event === 'note') {
      if (e.behavior === 'editor') say(e, 'human', String(e.text).replace(/^You /, ''), { human: true })
      // The adjudicator's decision is already its own line in the history.
      else if (e.forHuman && e.behavior !== 'adjudicate') say(e, 'galley', `noted: ${String(e.text)}`)
      continue
    }
    if (e.event !== 'settled') continue
    const behavior = String(e.behavior)
    // Stages only move forward: evidence sought during review, or the final reframing, is part of the stage it happens in.
    const next = STAGE_OF[behavior]
    if (next && STAGE_ORDER.indexOf(next) > STAGE_ORDER.indexOf(stage)) stage = next
    const target = String(e.target ?? '')
    const ids = target.replace(/^[a-z-]+:/, '').split(',').filter(Boolean)
    const seat = WORKS[behavior] ?? 'galley'
    const place = placeOf(s, behavior, target)
    const where = { ...(place.section ? { section: place.section } : {}), ...(place.finding ? { finding: place.finding } : {}) }
    if (e.how === 'skipped') { say(e, seat, `gave up ${doing(s, behavior, target)}; the paper went on without it.`, where); continue }
    switch (behavior) {
      case 'extract': say(e, seat, `read your seed: ${plural(s.claims.filter((c) => c.origin === 'seed').length, 'claim')} in your words.`); break
      case 'position': say(e, seat, `placed the idea among prior work: ${String(s.positioning.priorArt?.verdict ?? 'done').replace(/_/g, ' ')}.`); break
      case 'review-idea': say(e, seat, `scored the idea ${s.ideaReview ? s.ideaReview.factors.reduce((a, f) => a + f.score, 0) : '?'} of 21: ${String(s.ideaReview?.verdict ?? '').replace(/_/g, ' ')}.`); break
      case 'reformulate': say(e, seat, 'proposed three directions.'); break
      case 'select-direction': say(e, seat, `chose “${s.directions.find((d) => d.id === s.selectedDirection?.id)?.title ?? 'a direction'}”.`); break
      case 'literature-review': say(e, 'galley', 'received the systematic review from Canary.'); break
      case 'plan': say(e, seat, 'planned the argument and set a working title.'); break
      case 'outline': say(e, seat, `outlined ${plural(s.outline?.sections.length ?? 0, 'section')}.`); break
      case 'find-evidence': say(e, seat, `searched for sources for ${ids.length > 3 ? plural(ids.length, 'claim') : ids.join(', ')}.`, where); break
      case 'verify': say(e, seat, `checked ${plural(ids.length, 'citation')} against their passages.`, where); break
      case 'calibrate': say(e, seat, s.calibration ? `caught ${s.calibration.caught} of ${s.calibration.planted} planted defects.` : 'tested itself with planted defects.'); break
      case 'draft': say(e, seat, `drafted ${sectionTitle(ids[0])}.`, where); break
      case 'figure': say(e, seat, `drew ${ids[0]}.`, where); break
      case 'fidelity': say(e, seat, `checked ${sectionTitle(ids[0])} against its claims.`, where); break
      case 'frame': say(e, seat, frames++ ? 'rewrote the title and abstract from the reviewed text.' : 'wrote the title and abstract.'); break
      case 'close-round': say(e, 'galley', `closed round ${target.replace(/\D+/g, '') || ''}: every referee has reported.`); break
      case 'respond': say(e, seat, `answered ${ids.length > 1 ? plural(ids.length, 'finding') : ids[0]?.replace(/\.\d+$/, '')}.`, where); break
      case 'verify-disposition': say(e, seat, `judged ${plural(ids.length, 'answer')}.`, where); break
      case 'adjudicate': say(e, seat, `settled ${ids[0]}.`, where); break
      case 'reconcile': say(e, seat, 'read the final text against every claim.'); break
      case 'reprofile': say(e, seat, 'profiled the finished paper.'); break
      case 'typeset': say(e, 'galley', 'typeset the paper: PDF, LaTeX, Word, evidence package and sign-off sheet.'); break
      case 'ready': say(e, 'galley', 'marked the paper ready for submission. The sign-off is yours.'); break
      case 'referee': break
      default: say(e, seat, `finished ${behavior}.`, where)
    }
  }
  return out
}

function workingNotes(s: PaperState, config: { rounds?: number, literatureReview?: unknown, simulation?: unknown }): WorkingNote[] {
  const notes: WorkingNote[] = []
  const note = (key: string, label: string, text: string, seat: string, family: Family | null = null) => notes.push({ key, label, text, seat, family })
  if (!s.brief) note('start', 'Starting', 'The Author is reading your seed.', 'author')
  else note('seed', 'Seed read', `${plural(s.claims.filter((c) => c.origin === 'seed').length, 'claim')}, in your words · ${s.brief.field}`, 'author')
  if (s.positioning.priorArt) note('placed', 'Placed', `${s.positioning.priorArt.verdict.replace(/_/g, ' ')} · ${s.positioning.priorArt.summary.split(/(?<=\.)\s/)[0]}`, 'checker')
  const profile = s.profileAfter ?? s.ideaReview
  if (profile) note('idea', s.profileAfter ? 'Profile' : 'Idea', `${profile.verdict.replace(/_/g, ' ')} · ${profile.factors.reduce((a, f) => a + f.score, 0)} of 21`, 'challenger')
  if (s.directions.length) note('direction', 'Direction', s.selectedDirection ? `${s.selectedDirection.id} · ${s.directions.find((d) => d.id === s.selectedDirection!.id)?.title ?? ''}` : 'Three directions proposed; one to choose', 'checker')
  if (config.literatureReview && s.literature) note('literature', 'Review', s.literature.status === 'done' ? `${s.literature.counts?.reviewed ?? '?'} publications read · ${s.literature.counts?.findings ?? '?'} findings audited` : s.literature.status === 'failed' ? 'ended without an answer' : 'Canary is reading the literature', 'galley')
  if (s.outline) {
    const verified = s.citations.filter((c) => c.status === 'verified').length
    const rejected = s.citations.filter((c) => c.status === 'rejected').length
    note('evidence', 'Evidence', `${verified} sources verified · ${rejected} rejected${s.calibration ? ` · ${s.calibration.caught}/${s.calibration.planted} planted defects caught` : ''}`, 'verifier')
    const live = s.claims.filter((c) => c.status !== 'dropped')
    const n = (status: string) => live.filter((c) => c.status === status).length
    note('claims', 'Claims', `${live.length} in the ledger · ${n('supported') + n('narrowed')} sourced · ${n('internal')} your own work · ${plural(n('unsupported'), 'hypothesis', 'hypotheses')}`, 'checker')
    const drafted = s.outline.sections.filter((sec) => s.passages[sec.id]).length
    note('sections', 'Sections', `${drafted} of ${s.outline.sections.length} written`, 'author')
  }
  if (s.round) {
    const findings = s.findings.filter((f) => f.origin === 'agent')
    note('review', 'Review', `Round ${s.round} of ${config.rounds ?? s.round} · ${plural(findings.length, 'finding')} · ${findings.filter((f) => f.status === 'open').length} open`, 'referee')
  }
  if (s.outcome === 'ready_for_submission') note('ready', 'Ready', 'Every gate holds on one revision. The sign-off is yours.', 'galley')
  return notes
}

/** Everything a host draws about a paper in progress. */
export function liveView(dir: string, options: { limit?: number } = {}): LiveView | null {
  const s = readJson<PaperState>(join(dir, 'state.json'))
  if (!s) return null
  const config = Paper.readConfig(dir)
  const progress = readJson<{ pid: number, outcome: string | null, inFlight?: { behavior: string, target: string, what: string, started: string, family?: Family }[] }>(join(dir, 'progress.json'))
  let running = false
  if (progress && !progress.outcome && !s.outcome) {
    try { process.kill(progress.pid, 0); running = true } catch { /* the run has ended */ }
  }
  const now: LiveSeat[] = running ? (progress?.inFlight ?? []).map((f) => {
    const m = f.what.match(/^(.+) \(([^)]+)\)$/)
    const model = m?.[1] ?? f.what
    const seat = (m?.[2] ?? 'galley').replace(/^referee:/, '')
    const place = placeOf(s, f.behavior, f.target)
    return { seat, name: seatName(seat), family: f.family ?? familyOf(model), model, doing: doing(s, f.behavior, f.target), section: place.section, finding: place.finding, seconds: Math.max(0, Math.round((Date.now() - Date.parse(f.started)) / 1000)) }
  }) : []
  const lines = existsSync(join(dir, 'journal.jsonl')) ? readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean) : []
  const events = lines.map((line) => { try { return JSON.parse(line) as JournalEvent } catch { return null } }).filter((e): e is JournalEvent => !!e)
  // A usage limit being waited out shows until the next call or step after it.
  let waiting: LiveView['waiting'] = null
  if (running) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.event === 'call' || e.event === 'settled') break
      if (e.event !== 'provider_limit') continue
      const until = new Date(Date.parse(e.at) + Number(e.wait_ms)).toISOString()
      if (Date.parse(until) > Date.now()) waiting = { family: e.family, name: e.identity ?? FAMILY_NAMES[e.family as Family] ?? e.family, until }
      break
    }
  }
  const done = new Set(Object.keys(s.settled).map((key) => key.split(':')[0]))
  const stages = [
    { id: 'seed', label: 'Seed', done: !!s.brief },
    { id: 'aim', label: 'Aim', done: !!s.selectedDirection || !!s.plan },
    { id: 'plan', label: 'Plan', done: !!s.outline },
    { id: 'evidence', label: 'Evidence', done: done.has('calibrate') || (!!s.outline && Object.keys(s.passages).length > 0) },
    { id: 'draft', label: 'Draft', done: !!s.frame },
    { id: 'review', label: 'Review', done: done.has('reconcile') || !!s.outcome },
    { id: 'finish', label: 'Finish', done: s.outcome === 'ready_for_submission' },
  ]
  const current = stages.find((x) => !x.done) ?? stages[stages.length - 1]
  const all = activity(s, events)
  // Referees rotate families between rounds: each shows the family it last worked as.
  const lastAs: Record<string, Family> = {}
  for (const e of events) {
    if (e.event === 'call' && e.family) lastAs[String(e.seat).replace(/^referee:/, '')] = e.family
    if (e.event === 'review' && e.family) lastAs[String(e.seat)] = e.family
  }
  const member = (seat: string, family: Family | null) => {
    const assigned = config.routing && config.routing.places[seat as Place] !== 'independent' ? modelForPlace(config.routing, seat as Place).identity : null
    return { seat, name: seatName(seat), family, detail: assigned ?? (family ? FAMILY_NAMES[family] : null) }
  }
  const team = [
    ...(['author', 'checker', 'challenger', 'verifier'] as const).map((seat) => member(seat, config.seats[seat] ?? null)),
    ...config.referees.map((r) => member(r.seat, lastAs[r.seat] ?? (config.routing ? r.family : null))),
    member('adjudicator', lastAs.adjudicator ?? null),
  ]
  const sections = (s.outline?.sections ?? []).map((sec) => ({ id: sec.id, title: sec.title, written: !!s.passages[sec.id] }))
  return {
    slug: s.slug,
    doc: editorSlug(s.slug),
    title: config.title || s.titleByHuman || s.frame?.title || s.plan?.workingTitle || 'Untitled paper',
    running,
    outcome: s.outcome ?? null,
    stage: { id: current.id, label: STAGE_LABEL[current.id] ?? current.label },
    stages,
    team,
    sections,
    now,
    waiting,
    notes: workingNotes(s, config),
    activity: all.slice(-(options.limit ?? 400)),
  }
}
