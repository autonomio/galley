// What a host shows while a paper is being written, read from the paper's own
// files and never touching the run: who is working right now and on what, where
// the paper stands, its working notes, and what has happened, in the words a
// person reads. A host polls it beside the editor; the editor's copy carries
// the text and the threads themselves.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
  /** A paper, or a thesis handed back as a brief. */
  mode: 'paper' | 'thesis'
  running: boolean
  outcome: string | null
  /** Finished: a paper ready for submission or finished with defects open, or a thesis whose brief is written. */
  ready: boolean
  /** Defects a reader would see that the last reading of a finished paper left open; 0 when it is ready. */
  open: number
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
  /** When anything in the paper's folder last changed. */
  updated: string | null
  /** When the paper was started. */
  started: string | null
  /** How far the writing and the review have come, as numbers: what the working notes say in words. */
  progress: {
    sections: { written: number, total: number } | null
    review: { round: number, rounds: number, findings: number, open: number } | null
  }
}

const SEATS: Record<string, string> = { author: 'Author', checker: 'Checker', challenger: 'Challenger', verifier: 'Verifier', adjudicator: 'Adjudicator', referee: 'Referee', human: 'You', galley: 'Galley' }
const seatName = (seat: string) => SEATS[seat] ?? `${seat.charAt(0).toUpperCase()}${seat.slice(1)} referee`
const familyOf = (model: string): Family | null => model.startsWith('claude') ? 'claude' : model.startsWith('gpt') ? 'gpt' : model.startsWith('gemini') ? 'gemini' : null

// Which seat does a behavior's work, for the activity line.
const WORKS: Record<string, string> = {
  extract: 'author', plan: 'author', outline: 'author', draft: 'author', figure: 'author', frame: 'author', respond: 'author', analyze: 'author', simulate: 'author', formulate: 'author',
  position: 'checker', 'select-direction': 'checker', 'find-evidence': 'checker', fidelity: 'checker', reconcile: 'checker',
  'review-idea': 'challenger', reformulate: 'challenger', reprofile: 'challenger', reassess: 'challenger', 'test-thesis': 'challenger',
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
  formulate: 'thesis', 'test-thesis': 'test', 'thesis-brief': 'brief',
}
// A thesis's own stages come after the ones it shares with a paper; the two runs never mix them.
const STAGE_ORDER = ['seed', 'aim', 'substance', 'plan', 'evidence', 'draft', 'review', 'finish', 'thesis', 'test', 'brief']
const STAGE_LABEL: Record<string, string> = { seed: 'Seed', aim: 'Aim', substance: 'Materials', plan: 'Plan', evidence: 'Evidence', draft: 'Draft', review: 'Review', finish: 'Finish', thesis: 'Thesis', test: 'Test', brief: 'Brief' }

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
    case 'literature-review': return 'running the literature review with Canary'
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
    case 'formulate': return 'formulating the thesis'
    case 'test-thesis': return 'testing the thesis against the literature'
    case 'thesis-brief': return 'writing the brief'
    default: return behavior
  }
}

interface JournalEvent { at: string, event: string, [key: string]: any }

/** The journal as sentences, oldest first. */
/** The journal as sentences, oldest first. Each reads after its actor's name: "Author drafted Introduction." */
function activity(s: PaperState, events: JournalEvent[], mode: 'paper' | 'thesis' = 'paper', pdf = false): LiveEntry[] {
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
    if (e.event === 'created') { say(e, 'human', `started the ${mode} from your seed.`, { human: true }); continue }
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
      case 'literature-review': say(e, 'galley', 'received the literature review from Canary.'); break
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
      case 'ready': say(e, 'galley', s.outcome === 'finished_with_open_defects' ? `finished the paper with ${plural(openDefects(s), 'defect')} a reader would see still open. The sign-off lists them.` : 'marked the paper ready for submission. The sign-off is yours.'); break
      case 'formulate': say(e, seat, target.startsWith('revision') ? 'formulated the thesis again after its test.' : 'formulated the thesis.'); break
      case 'test-thesis': say(e, seat, 'tested the thesis against the literature, for its direction.'); break
      case 'thesis-brief': say(e, 'galley', pdf ? 'wrote the brief into the document, with a PDF beside it.' : 'wrote the brief into the document.'); break
      case 'referee': break
      default: say(e, seat, `finished ${behavior}.`, where)
    }
  }
  return out
}

function workingNotes(s: PaperState, config: { rounds?: number, literatureReview?: unknown, simulation?: unknown, datasets?: unknown[], materials?: { kind?: string }[], off?: string[], title?: string }, pdf = false): WorkingNote[] {
  const notes: WorkingNote[] = []
  const note = (key: string, label: string, text: string, seat: string, family: Family | null = null) => notes.push({ key, label, text, seat, family })
  if (!s.brief) note('start', 'Starting', 'The Author is reading your seed.', 'author')
  else note('seed', 'Seed read', `${plural(s.claims.filter((c) => c.origin === 'seed').length, 'claim')}, in your words · ${s.brief.field}`, 'author')
  if (s.positioning.priorArt) note('placed', 'Placed', `${s.positioning.priorArt.verdict.replace(/_/g, ' ')} · ${s.positioning.priorArt.summary.split(/(?<=\.)\s/)[0]}`, 'checker')
  const profile = s.profileAfter ?? s.ideaReview
  if (profile) note('idea', s.profileAfter ? 'Profile' : 'Idea', `${profile.verdict.replace(/_/g, ' ')} · ${profile.factors.reduce((a, f) => a + f.score, 0)} of 21`, 'challenger')
  // The direction chosen: one of those proposed, or the seed's own.
  const chosen = s.selectedDirection && s.directions.find((d) => d.id === s.selectedDirection!.id)
  if (s.directions.length) note('direction', 'Direction', !s.selectedDirection ? 'Three directions proposed; one to choose' : chosen ? `${chosen.id} · ${chosen.title}` : `${s.selectedDirection.id} · the seed's own`, 'checker')
  if (config.literatureReview && s.literature) note('literature', 'Review', s.literature.status === 'done' ? `${s.literature.counts?.reviewed ?? '?'} publications read · ${s.literature.counts?.findings ?? '?'} findings audited` : s.literature.status === 'failed' ? 'ended without an answer' : 'Canary is reading the literature', 'galley')
  // The analysis of the authors' data, step by step: planned and reviewed, extracts taken, the shared preparation, the analyses computed.
  const a = s.analysis
  if (a?.plan.length) {
    const computed = Object.values(a.runs ?? {}).filter((r) => r.ok).length
    note('analysis', 'Analysis', [
      `${plural(a.plan.length, 'analysis', 'analyses')} planned${a.reviewed ? `, reviewed by ${FAMILY_NAMES[a.reviewed.family] ?? a.reviewed.family}` : ', in review'}`,
      ...(a.extracts?.length ? [`${a.extracts.filter((e) => e.ok).length} of ${a.extracts.length} extracts taken`] : []),
      ...(a.mode === 'code' ? [a.prepare?.ok ? 'shared preparation done' : 'shared preparation being written'] : []),
      `${computed} of ${a.plan.length} computed${a.notComputed?.length ? ` · ${a.notComputed.length} not computed` : ''}`,
    ].join(' · '), 'author')
  } else if (config.datasets?.length || config.materials?.some((m) => m.kind === 'dataset')) note('analysis', 'Analysis', 'The Author is planning the analysis of your data.', 'author')
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
  const test = s.thesis?.test
  if (s.thesis) note('thesis', 'Thesis', `${config.title || s.thesis.title || s.thesis.statement}${test ? ` · ${test.passes ? 'meets its test' : 'does not yet meet its test'}${test.searched === null ? ', without a novelty search' : ''}` : (config.off ?? []).includes('test-thesis') ? ' · not tested: the test is off for this run' : ' · being tested'}`, 'author')
  if (s.outcome === 'ready_for_submission') note('ready', 'Ready', 'Every gate holds on one revision. The sign-off is yours.', 'galley')
  if (s.outcome === 'finished_with_open_defects') note('ready', 'Finished', `The last reading of the typeset paper left ${plural(openDefects(s), 'defect')} a reader would see that it could not fix. The sign-off lists them.`, 'galley')
  if (s.outcome === 'thesis_ready') note('ready', 'Ready', pdf ? 'The brief is in the document, with a PDF beside it.' : 'The brief is in the document; its PDF was not made.', 'galley')
  return notes
}

/** The title the seed gives itself, in its first heading, before the run has one of its own. */
const seedTitle = (text: string | undefined) => text?.match(/^#{1,2}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim() || null
const finished = (outcome: string | null | undefined) => outcome === 'ready_for_submission' || outcome === 'finished_with_open_defects' || outcome === 'thesis_ready'
/** What the last reading of a finished paper left open that a reader would see. */
const openDefects = (s: PaperState) => s.outcome === 'finished_with_open_defects' ? (s.proof?.left ?? []).filter((d) => d.severity !== 'P2' && d.severity !== 'P3').length : 0

/** Everything a host draws about a paper in progress. */
export function liveView(dir: string, options: { limit?: number } = {}): LiveView | null {
  const s = readJson<PaperState>(join(dir, 'state.json'))
  if (!s) return null
  const config = Paper.readConfig(dir)
  const mode = config.mode === 'thesis' ? 'thesis' as const : 'paper' as const
  // The brief's PDF is made when it can be; a brief can be ready without one.
  const pdf = existsSync(join(dir, 'out', 'thesis.pdf'))
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
  // A thesis's stages, as the CLI's status names them.
  const stages = mode === 'thesis' ? [
    { id: 'seed', label: 'Seed', done: !!s.brief },
    { id: 'aim', label: 'Place the idea', done: done.has('position') },
    // Settled as the thesis takes it: in, ended, or not part of this run.
    { id: 'literature', label: 'Literature', done: !config.literatureReview || (config.off ?? []).includes('literature-review') || (!!s.literature && s.literature.status !== 'running') },
    { id: 'thesis', label: 'Thesis', done: !!s.thesis },
    { id: 'test', label: 'Test', done: !!s.thesis?.test || (config.off ?? []).includes('test-thesis') },
    { id: 'brief', label: 'Brief', done: s.outcome === 'thesis_ready' },
  ] : [
    { id: 'seed', label: 'Seed', done: !!s.brief },
    { id: 'aim', label: 'Aim', done: !!s.selectedDirection || !!s.plan },
    { id: 'plan', label: 'Plan', done: !!s.outline },
    { id: 'evidence', label: 'Evidence', done: done.has('calibrate') || (!!s.outline && Object.keys(s.passages).length > 0) },
    { id: 'draft', label: 'Draft', done: !!s.frame },
    { id: 'review', label: 'Review', done: done.has('reconcile') || !!s.outcome },
    { id: 'finish', label: 'Finish', done: s.outcome === 'ready_for_submission' || s.outcome === 'finished_with_open_defects' },
  ]
  // A finished run stands at its last stage, whatever an earlier one recorded.
  const current = (finished(s.outcome) ? undefined : stages.find((x) => !x.done)) ?? stages[stages.length - 1]
  const all = activity(s, events, mode, pdf)
  // Referees rotate families between rounds: each shows the family it last worked as.
  const lastAs: Record<string, Family> = {}
  for (const e of events) {
    if (e.event === 'call' && e.family) lastAs[String(e.seat).replace(/^referee:/, '')] = e.family
    if (e.event === 'review' && e.family) lastAs[String(e.seat)] = e.family
  }
  const member = (seat: string, family: Family | null) => {
    const assigned = config.routing && config.routing.places[seat as Place] && config.routing.places[seat as Place] !== 'independent' ? modelForPlace(config.routing, seat as Place).identity : null
    return { seat, name: seatName(seat), family, detail: assigned ?? (family ? FAMILY_NAMES[family] : null) }
  }
  const team = [
    ...(['author', 'checker', 'challenger', 'verifier'] as const).map((seat) => member(seat, config.seats[seat] ?? null)),
    ...config.referees.map((r) => member(r.seat, lastAs[r.seat] ?? (config.routing ? r.family : null))),
    member('adjudicator', lastAs.adjudicator ?? null),
  ]
  const sections = (s.outline?.sections ?? []).map((sec) => ({ id: sec.id, title: sec.title, written: !!s.passages[sec.id] }))
  const findings = s.findings.filter((f) => f.origin === 'agent')
  // A paper that does not set its rounds has the engine's default, never just the round it is in.
  const rounds = Math.max(config.rounds, s.round)
  return {
    slug: s.slug,
    doc: config.editorDoc || editorSlug(s.slug),
    // The person's title, else the run's own, else the one the seed gives itself.
    title: config.title || s.titleByHuman || (mode === 'thesis' ? s.thesis?.title : s.frame?.title || s.plan?.workingTitle) || seedTitle(s.seed?.text) || `Untitled ${mode}`,
    mode,
    running,
    outcome: s.outcome ?? null,
    ready: finished(s.outcome),
    open: openDefects(s),
    stage: { id: current.id, label: mode === 'thesis' ? current.label : STAGE_LABEL[current.id] ?? current.label },
    stages,
    team,
    sections,
    now,
    waiting,
    notes: [...workingNotes(s, { ...config, rounds }, pdf), lastActivity(dir, running, now, s.outcome ?? null)],
    activity: all.slice(-(options.limit ?? 400)),
    updated: updatedAt(dir),
    started: s.createdAt ?? null,
    progress: {
      sections: s.outline ? { written: sections.filter((sec) => sec.written).length, total: sections.length } : null,
      review: s.round ? { round: s.round, rounds, findings: findings.length, open: findings.filter((f) => f.status === 'open').length } : null,
    },
  }
}

/**
 * Every paper in a folder of papers, as liveView sees each, with the folder it is in: those being written first, then
 * those ready, then those stopped, each newest first. The order stays put while the papers change, so a list drawn from
 * it does not reshuffle at every step.
 */
export function livePapers(root: string, options: { limit?: number } = {}): { dir: string, view: LiveView }[] {
  if (!existsSync(root)) return []
  const rank = (v: LiveView) => (v.running ? 0 : v.ready ? 1 : 2)
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ dir: join(root, entry.name), view: liveView(join(root, entry.name), { limit: options.limit ?? 3 }) }))
    .filter((p): p is { dir: string, view: LiveView } => !!p.view)
    .sort((a, b) => rank(a.view) - rank(b.view) || (b.view.started ?? '').localeCompare(a.view.started ?? '') || a.view.slug.localeCompare(b.view.slug))
}

/** When anything in the paper's folder last changed: its state, the run's progress, its journal or its log. */
function updatedAt(dir: string): string | null {
  const times = ['state.json', 'progress.json', 'journal.jsonl', 'run.log'].map((file) => { try { return statSync(join(dir, file)).mtimeMs } catch { return 0 } })
  const last = Math.max(...times)
  return last ? new Date(last).toISOString() : null
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min ago`
}

/**
 * The last note: how long ago anything in the paper last changed, and what is being worked on right now, so a person
 * can see the run is alive even while a long step shows nothing new.
 */
function lastActivity(dir: string, running: boolean, now: LiveSeat[], outcome: string | null): WorkingNote {
  const updated = updatedAt(dir)
  const when = updated ? `${ago(Date.now() - Date.parse(updated))} (${new Date(updated).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })})` : 'not yet'
  // One line per seat at work: what it is doing, for how long, and how many more it is doing at once.
  const bySeat = new Map<string, LiveSeat[]>()
  for (const n of now) bySeat.set(n.name, [...(bySeat.get(n.name) ?? []), n])
  const working = [...bySeat].map(([name, list]) => {
    const longest = list.reduce((a, b) => (b.seconds > a.seconds ? b : a))
    return `${name} ${longest.doing} (${longest.seconds < 60 ? `${longest.seconds} s` : `${Math.round(longest.seconds / 60)} min`}${list.length > 1 ? `, ${list.length} at once` : ''})`
  })
  const state = finished(outcome) ? '' : running ? (working.length ? ` · now: ${working.join('; ')}` : ' · between steps') : ' · the run has stopped; run it again to resume'
  return { key: 'updated', label: 'Last activity', text: `${when}${state}`, seat: 'galley', family: null }
}
