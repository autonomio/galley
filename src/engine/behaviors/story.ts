// The story. Once the research is done and reviewed, the paper is told: its main findings first and plainly, its
// caveats in one Limitations section and nowhere else, a worked example a reader can follow by hand, one language and
// register throughout, a title that needs no paper to understand, and charts where they carry the argument. After the
// final frame it is read through three times, as a reader meets it, for what still complicates, confuses or pulls two
// ways. None of it changes the research: every claim keeps its strength and its conditions, and every number,
// citation and formal statement the reviewed text held, it still holds. Code checks that nothing the research rests
// on is gone, and a family other than the author's reads every change against what it was; a change that fails
// either is undone, and the paper keeps the text it had.
import type { Paper } from '../paper.js'
import { HOUSE, STYLE } from '../prompts.js'
import { fillPlaceholders, productionRecord, type Record_ } from '../record.js'
import type { Behavior, Target } from '../scheduler.js'
import { arr, bool, enm, num, obj, str, type Schema } from '../schema.js'
import { compile, parse } from '../simulation/expression.js'
import { applyExact, citedKeys, words, type Edit } from '../text.js'
import type { ChartPanel, ChartPlan, Figure, Section } from '../types.js'
import { astetikCatalog, astetikCommand, chartCatalog, drawable, drawChart } from '../charts.js'
import { reviewDone } from './close.js'
import { live, placeholderLegend, seatFamily, sectionText } from './common.js'
import { selfTalk } from './proof.js'
import { setPassage } from './write.js'

/** How many times the told paper is read through. */
export const READS = 3
/** The most data charts a paper carries, counting those it had. */
const MAX_CHARTS = 3
/** The id of the Limitations section when the story writes one. */
const LIMITS = 'SL'

/** The steps that tell the paper, in the order they run, each settled under its key. */
export const STORY_STEPS = [
  { id: 'story-caveats', key: 'story:caveats' },
  { id: 'story-lead', key: 'story:lead' },
  { id: 'story-example', key: 'story:example' },
  { id: 'story-register', key: 'story:register' },
  { id: 'story-charts', key: 'story:charts' },
] as const

const off = (paper: Paper, id: string) => paper.config.off.includes(id) || paper.config.off.includes('story')
const stepDone = (paper: Paper, i: number) => off(paper, STORY_STEPS[i].id) || paper.isSettled(STORY_STEPS[i].key)

/** Whether the paper has been told: every step done, skipped or switched off. The copyedit reads the told text. */
export function storyTold(paper: Paper): boolean {
  return STORY_STEPS.every((_, i) => stepDone(paper, i))
}

/** Whether the told paper has been read through as often as it is read; the typeset paper is proofread after. */
export function storyReadDone(paper: Paper): boolean {
  return off(paper, 'story-read') || paper.isSettled(`story:read:${READS}`)
}

/** Whether a story step may run now: review is done, the works the text names are cited, the steps before it ran. */
function telling(paper: Paper, step: number): boolean {
  const s = paper.state
  if (!live(paper) || s.outcome || !s.outline || !s.frame || !reviewDone(paper) || paper.isSettled('frame:final')) return false
  if (!paper.isSettled('named:works') && !paper.config.off.includes('cite-named')) return false
  return STORY_STEPS.slice(0, step).every((_, i) => stepDone(paper, i))
}

const STORY = `The research in this manuscript is finished and has been through review; you are now telling it. Change how the paper tells its research, never the research: every claim keeps its strength and its conditions; every number, citation, definition, proposition, equation and table stays in the paper; nothing is added that the research did not establish, and no source is cited that the paper does not already cite. A {{placeholder}} is a recorded number: it stays exactly as written wherever it stands, and moves only whole. Name every quantity, object and result by the paper's own term for it, exactly as the paper defines it: a bound stays a bound, an estimate an estimate, a modeled cost a modeled cost.
Outside its section on the use of AI, the paper never speaks of how it was made: it names no tool or model that produced it, and never speaks of a run, a record of its own making (a simulation record, an analysis record), what that record does or does not show, a ledger, a check or a review step. It states the work, its methods and its sources.
Edits are exact: in is the id in brackets of the part the edit is made in, old is copied character for character from that part as given below (long enough to occur once in it), and new replaces it. To add a paragraph, give the sentence it follows as old, and that sentence followed by the new paragraph as new. Change nothing your task does not need.`

/** One part of the paper a story step reads: its title, its abstract, a section or a figure caption. */
interface Part { id: string; head: string; text: string }

/** The figures as they print, in order, each with its number. */
export function printedOrder(paper: Paper): Figure[] {
  const s = paper.state
  return (s.outline?.sections ?? []).flatMap((sec) => s.figures.filter((f) => f.sectionId === sec.id && f.status === 'rendered' && f.file))
}

function partsOf(paper: Paper, frame: boolean): Part[] {
  const s = paper.state
  const parts: Part[] = []
  if (frame && s.frame) {
    parts.push({ id: 'title', head: 'Title', text: titleOf(paper) })
    parts.push({ id: 'abstract', head: 'Abstract', text: s.frame.abstract })
  }
  for (const sec of s.outline?.sections ?? []) parts.push({ id: sec.id, head: `# ${sec.title}`, text: sectionText(paper, sec.id) })
  printedOrder(paper).forEach((fig, i) => parts.push({ id: fig.id, head: `Caption of Figure ${i + 1}`, text: fig.caption }))
  return parts
}

const titleOf = (paper: Paper) => paper.config.title || paper.state.titleByHuman || paper.state.frame?.title || ''
const titleIsTheAuthors = (paper: Paper) => Boolean(paper.config.title || paper.state.titleByHuman)

function block(parts: Part[], texts: Map<string, string>, record: Record_ | null): string {
  return parts.filter((p) => texts.has(p.id)).map((p) => {
    const text = texts.get(p.id)!
    return `[${p.id}] ${p.head}\n\n${record ? fillPlaceholders(text, record).text : text}`
  }).join('\n\n')
}

/** Applies exact edits to the parts they name; an edit whose words are not found once in its part is not applied. */
export function applyEdits(texts: Map<string, string>, edits: Edit[] & { in?: string }[], editable: Set<string>): { applied: number; failed: number } {
  let applied = 0, failed = 0
  for (const edit of edits as (Edit & { in: string })[]) {
    const id = String(edit.in ?? '').replace(/[[\]]/g, '').trim()
    const before = texts.get(id)
    if (before === undefined || !editable.has(id)) { failed++; continue }
    const after = applyExact(before, { old: String(edit.old ?? ''), new: String(edit.new ?? '') })
    if (after === null) { failed++; continue }
    texts.set(id, after)
    applied++
  }
  return { applied, failed }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g
const STATEMENT = /\*\*((?:Definition|Proposition|Theorem|Lemma|Corollary|Conjecture|Assumption|Hypothesis|Example|Remark)\s+\d+)/g
const TABLE_RULE = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/gm
const DISPLAY = /\$\$/g

/**
 * What a rewrite lost or added that the research rests on, part by part: a citation, a recorded number, a numbered
 * statement, a table or a displayed equation the paper no longer holds anywhere, or a source or number it never had.
 * Nothing, when the rewrite only retells the research.
 */
export function researchLost(before: Map<string, string>, after: Map<string, string>, record: Record_): Map<string, string[]> {
  const whole = (m: Map<string, string>) => [...m.values()].join('\n\n')
  const was = whole(before), now = whole(after)
  const set = (text: string, re: RegExp) => new Set([...text.matchAll(re)].map((m) => m[1]))
  const count = (text: string, re: RegExp) => (text.match(re) ?? []).length
  const keysNow = new Set(citedKeys(now)), keysWas = new Set(citedKeys(was))
  const numbersNow = set(now, PLACEHOLDER), statementsNow = set(now, STATEMENT)
  const problems = new Map<string, string[]>()
  for (const [id, text] of after) {
    const old = before.get(id) ?? ''
    if (old === text) continue
    const lost: string[] = []
    for (const k of citedKeys(old)) if (!keysNow.has(k)) lost.push(`it removes the paper's only citation of @${k}`)
    for (const k of citedKeys(text)) if (!keysWas.has(k)) lost.push(`it cites @${k}, which the paper did not cite`)
    for (const p of set(old, PLACEHOLDER)) if (!numbersNow.has(p)) lost.push(`it removes the paper's only statement of {{${p}}}`)
    for (const p of set(text, PLACEHOLDER)) if (!(p in record)) lost.push(`{{${p}}} is not a recorded number`)
    for (const statement of set(old, STATEMENT)) if (!statementsNow.has(statement)) lost.push(`${statement} is gone`)
    if (count(text, TABLE_RULE) < count(old, TABLE_RULE)) lost.push('it removes a table')
    if (count(text, DISPLAY) < count(old, DISPLAY)) lost.push('it removes a displayed equation')
    if (lost.length) problems.set(id, lost)
  }
  return problems
}

const MADE_NAMES = /\b(galley|Canary|Resolvent)\b/
const MADE_TERMS = /\b(?:simulation|analysis|production) record\b|\bclaim ledger\b|\bproduction journal\b|\bevidence package\b|\bsign-off sheet\b/i

/** The sentences of a text that speak of how the paper was made rather than of the work: printed only where the paper states its use of AI. */
export function madeTalk(text: string, aboutSystem = false): string[] {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((s) => s.trim()).filter(Boolean)
  return [...new Set([...selfTalk(text, aboutSystem), ...sentences.filter((s) => (!aboutSystem && MADE_NAMES.test(s)) || MADE_TERMS.test(s))])]
}

/** A number as a text writes it ("66,300", "4.23", "1.2 × 10^5", "98%"), with half a unit of its last digit as its tolerance. */
export function writtenNumber(value: string): { value: number; tolerance: number } | null {
  const m = value.trim().replace(/\$/g, '').replace(/\\(?:times|cdot)/g, '×').replace(/[{}]/g, '').replace(/[   ]/g, '').replace(/−/g, '-')
    .match(/^([-+]?\d{1,3}(?:,\d{3})+|[-+]?\d+)(?:\.(\d+))?(?:(?:×|x|\*)10\^\{?([-+]?\d+)\}?|e([-+]?\d+))?%?$/i)
  if (!m) return null
  const whole = m[1].replace(/,/g, '')
  const exponent = Number(m[3] ?? m[4] ?? 0)
  const n = Number(`${whole}${m[2] ? `.${m[2]}` : ''}`) * 10 ** exponent
  if (!Number.isFinite(n)) return null
  // A written 66,300 may round 66,312; a written 100 does not stand for 149.
  const zeros = m[2] ? 0 : (whole.match(/0+$/)?.[0].length ?? 0)
  const unit = m[2] ? 10 ** -m[2].length : Math.min(10 ** zeros, Math.max(1, 0.01 * Math.abs(Number(whole))))
  return { value: n, tolerance: (unit / 2) * 10 ** exponent }
}

/** Whether a worked number is what its arithmetic gives: null when it is, or what is wrong. */
export function checkCalculation(expression: string, value: string, record: Record_): string | null {
  let expr = String(expression)
  for (const m of [...expr.matchAll(PLACEHOLDER)]) {
    const recorded = record[m[1]]
    const n = recorded === undefined ? NaN : Number(String(recorded).replace(/[,\s]/g, ''))
    if (!Number.isFinite(n)) return `{{${m[1]}}} is not a recorded number`
    expr = expr.replace(m[0], `(${n})`)
  }
  expr = expr.replace(/×/g, '*').replace(/·/g, '*').replace(/−/g, '-').replace(/÷/g, '/').replace(/(\d),(?=\d{3}\b)/g, '$1')
  let computed: number
  try {
    computed = compile(parse(expr), (name) => { throw new Error(`"${name}" is not a number`) })(new Float64Array(0))
  } catch (error) {
    return `${expression} cannot be worked out: ${(error as Error).message}`
  }
  const written = writtenNumber(value)
  if (!written) return `"${value}" is not a number as written`
  if (!Number.isFinite(computed)) return `${expression} has no finite value`
  if (Math.abs(computed - written.value) > written.tolerance + 1e-9 * Math.abs(computed)) return `${expression} gives ${Number(computed.toPrecision(6))}, not ${value}`
  return null
}

interface Told {
  behavior: string
  /** What the step does, in a few words, for the reader who checks it and the record. */
  what: string
  task: string
  parts: Part[]
  editable: Set<string>
  /** Further fields the author returns besides edits. */
  schema?: Record<string, Schema>
  /** Puts the further fields into the texts; returns what must be put right before the change can stand. */
  extra?: (reply: any, texts: Map<string, string>, record: Record_) => string[]
  /** What the author needs besides the paper (notes, the recorded numbers). */
  context?: string
  /** A part the rest of the step depends on: when it cannot stand, nothing of the step is kept. */
  anchor?: string
}

/**
 * One story step: the author rewrites, the rewrite is checked by code and then by a family other than the author's,
 * and only what passes both is kept. What the step must put right (a wrong calculation, a limit worded as a remark on
 * how the paper was made) goes back to the author once; what is still wrong after that is not kept.
 */
async function tell(paper: Paper, step: Told): Promise<{ changed: string[]; undone: string[] }> {
  const record = productionRecord(paper)
  const before = new Map(step.parts.map((p) => [p.id, p.text]))
  const author = seatFamily(paper, 'author')
  const legend = placeholderLegend(paper, [...before.values()].join('\n'))
  const prompt = `${HOUSE}

${STYLE}

${STORY}

${step.task}
${legend ? `\n${legend}\n` : ''}${step.context ? `\n${step.context}\n` : ''}
THE PAPER:
${block(step.parts, before, null)}`
  const schema = obj({ edits: arr(obj({ in: str(), old: str(), new: str() })), ...(step.schema ?? {}) })
  const about = Boolean(paper.state.brief?.aboutSystem)
  const attempt = (answer: any) => {
    const texts = new Map(before)
    applyEdits(texts, answer.edits ?? [], step.editable)
    const problems = step.extra?.(answer, texts, record) ?? []
    // A story step never adds a word on how the paper was made.
    for (const [id, text] of texts) {
      if (text === (before.get(id) ?? '')) continue
      const was = new Set(madeTalk(before.get(id) ?? '', about))
      for (const sentence of madeTalk(text, about)) if (!was.has(sentence)) problems.push(`[${id}] this sentence speaks of how the paper was made, which the paper never does: "${sentence.slice(0, 240)}"`)
    }
    return { texts, problems }
  }
  let reply = await paper.ask<any>({ behavior: step.behavior, target: 'tell', seat: 'author', family: author, prompt, schema })
  let result = attempt(reply)
  // What must be put right goes back to the author once, with the rest of its answer kept.
  let repaired = false
  const repair = async (problems: string[]) => {
    repaired = true
    reply = await paper.ask<any>({
      behavior: step.behavior, target: 'repair', seat: 'author', family: author, schema,
      prompt: `${prompt}\n\nYOUR ANSWER:\n${JSON.stringify(reply).slice(0, 30_000)}\n\nIt cannot stand as it is:\n${problems.map((p) => `- ${p}`).join('\n')}\nReturn the complete answer again, edits included, with these put right; keep what was not questioned.`,
    })
    return attempt(reply)
  }
  if (result.problems.length) {
    result = await repair(result.problems)
    if (result.problems.length) {
      paper.note(step.behavior, `Left as it was: ${result.problems.slice(0, 4).join('; ')}.`)
      return { changed: [], undone: [] }
    }
  }
  const changedIn = (texts: Map<string, string>) => [...texts.keys()].filter((id) => texts.get(id) !== (before.get(id) ?? ''))
  // Code first, then a reader from another family: what either finds would change the research is not kept.
  const judge = async (texts: Map<string, string>) => {
    const undone = new Map<string, string>()
    for (const [id, lost] of researchLost(before, texts, record)) undone.set(id, lost.join('; '))
    const changed = changedIn(texts).filter((id) => !undone.has(id))
    for (const [id, what] of await objections(paper, step, before, texts, changed, record)) undone.set(id, what)
    return undone
  }
  let texts = result.texts
  let undone = await judge(texts)
  if (undone.size && !repaired) {
    const again = await repair([...undone].map(([id, what]) => `[${id}] this would change the research: ${what}`))
    if (!again.problems.length) { texts = again.texts; undone = await judge(texts) }
  }
  const proposed = changedIn(texts)
  for (const id of undone.keys()) texts.set(id, before.get(id) ?? '')
  // Parts that stand together (caveats moved and the section that now states them) stand or fall as one.
  if (step.anchor && proposed.includes(step.anchor) && undone.has(step.anchor)) {
    for (const id of texts.keys()) texts.set(id, before.get(id) ?? '')
  }
  const changed = changedIn(texts)
  commit(paper, texts, before, step.behavior)
  paper.journal({ event: 'story', step: step.behavior, changed, undone: undone.size })
  if (undone.size) paper.note(step.behavior, `${changed.length ? 'Changes' : 'The whole step was'} left out because ${changed.length ? 'they' : 'its parts'} would have changed the research: ${[...undone].slice(0, 6).map(([id, what]) => `${id}: ${what.slice(0, 300)}`).join(' | ')}`)
  paper.save()
  return { changed, undone: [...undone.keys()] }
}

/** A reader from a family other than the author's: each changed part against what it was, and what changes the research. */
async function objections(paper: Paper, step: Told, before: Map<string, string>, texts: Map<string, string>, changed: string[], record: Record_): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  if (!changed.length) return found
  const verdict = await paper.ask<any>({
    behavior: step.behavior, target: 'check', seat: 'checker', family: seatFamily(paper, 'checker'),
    prompt: `${HOUSE}

A storytelling step (${step.what}) rewrote parts of a finished, reviewed manuscript. It may change how the paper tells its research, never the research. Compare each changed part with what it was, against the paper as it now reads:
- kept: every claim the part held is still in the paper with the same strength and the same conditions; every number, citation, definition, proposition and table it held is still in the paper; it adds no claim, result, number or source the research did not already hold, and says nothing of the research that the paper does not support. A condition or caveat moved to the Limitations section, a scope stated once where the paper defines it instead of in every sentence, a number the paper holds now shown with its working in a worked example, a passage moved elsewhere in the paper, and a statement corrected so that it agrees with what the paper itself establishes (its definitions, propositions and results), are kept.
- changed: something the research holds was lost, strengthened, weakened, misstated or added; say exactly what.
For each changed part give id, verdict, and what (empty when kept).

CHANGED PARTS:
${changed.map((id) => `[${id}] BEFORE:\n${before.get(id) ? fillPlaceholders(before.get(id)!, record).text : '(not in the paper before)'}\n\n[${id}] AFTER:\n${fillPlaceholders(texts.get(id)!, record).text}`).join('\n\n')}

THE REST OF THE PAPER:
${block(step.parts.filter((p) => !changed.includes(p.id)), texts, record)}`,
    schema: obj({ parts: arr(obj({ id: str(), verdict: enm(['kept', 'changed']), what: str() })) }),
  })
  for (const part of verdict.parts ?? []) {
    const id = String(part.id ?? '').replace(/[[\]]/g, '').trim()
    if (part.verdict === 'changed' && changed.includes(id)) found.set(id, String(part.what ?? '').trim() || 'judged to change the research')
  }
  return found
}

/** Writes what a story step kept into the paper: sections, captions, the title, the abstract, the Limitations section. */
function commit(paper: Paper, texts: Map<string, string>, before: Map<string, string>, behavior: string): void {
  const s = paper.state
  const author = seatFamily(paper, 'author')
  const by = { kind: 'agent' as const, family: author, model: paper.config.models[author]?.model ?? author, seat: 'author' as const, behavior }
  for (const [id, text] of texts) {
    if ((before.get(id) ?? '') === text) continue
    if (id === 'title') { if (!titleIsTheAuthors(paper) && text.trim()) s.frame!.title = text.trim() }
    else if (id === 'abstract') s.frame!.abstract = text
    else if (s.figures.some((f) => f.id === id)) s.figures.find((f) => f.id === id)!.caption = text
    else if (id === limitsId(paper) && !s.outline!.sections.some((sec) => sec.id === id)) {
      if (!text.trim()) continue
      const section: Section = { id, title: 'Limitations', purpose: 'The limits of the work, each stated once.', claimIds: [], words: words(text), figureIds: [], role: 'limitations' }
      s.outline!.sections.push(section)
      setPassage(paper, id, text, by, 'the limits of the work, stated in one place')
    } else if (s.outline!.sections.some((sec) => sec.id === id)) setPassage(paper, id, text, by, `told: ${behavior.replace(/^story-/, '')}`)
  }
}

const limitsId = (paper: Paper) => paper.state.outline?.sections.find((sec) => sec.role === 'limitations')?.id ?? LIMITS
const bodySections = (paper: Paper) => (paper.state.outline?.sections ?? []).filter((sec) => sec.role !== 'limitations')

function stepTarget(paper: Paper, index: number, label: string, run: () => Promise<void>): Target[] {
  const { key } = STORY_STEPS[index]
  if (!telling(paper, index) || paper.isSettled(key)) return []
  // An improvement: if it cannot run, the paper keeps the text it has.
  return [{ key, label, run, skip: () => {} }]
}

export const storyCaveats: Behavior = {
  id: 'story-caveats', stage: 'close', improver: true, title: 'Gather the caveats into the Limitations section',
  ready: (paper) => stepTarget(paper, 0, 'the caveats, into one Limitations section', async () => {
    const s = paper.state
    const id = limitsId(paper)
    const parts = partsOf(paper, false)
    if (!parts.some((p) => p.id === id)) parts.push({ id, head: '# Limitations (not yet written)', text: '' })
    const limits = (s.authorNotes ?? []).filter((n) => n.kind === 'limitation').map((n) => `- ${n.text}`)
    await tell(paper, {
      behavior: 'story-caveats', what: 'gathering the caveats into the Limitations section', parts, anchor: id,
      editable: new Set(parts.map((p) => p.id).filter((p) => p !== id)),
      task: `Your task: the caveats. The paper states the limits of its work in one place, its Limitations section, and nowhere else.
- A caveat says what the work does not show or how far its results may not reach: an assumption that may not hold in practice, a case or condition left untested, a comparison not made, a sample or setting that limits how far a result generalizes, a step taken on judgment. Find every caveat in the sections and figure captions, remove it from where it stands, and state it in the Limitations section. Move each caveat as it is written, changing only what it needs to read in its new place (a word like "this" replaced by what it refers to, a connecting word): its terms and its claim stay exactly as they were.
- What a result is about is not a caveat: the quantity measured, the model it is computed in, the setting and conventions it holds under. That stays where the paper defines it (its method or setup), stated once. Where a sentence reporting a result repeats a condition the paper has already stated, remove the repetition; where a condition is stated nowhere else, keep it with the result.
- limitations: the text of the Limitations section, without a heading. The limits of the work, each stated once, plainly and specifically, in the paper's own terms, with what each means for how far the results reach; include the limits listed below that hold for the text as it now reads, each in the paper's own terms. A paragraph for each limit or for a group of related limits; no bullet list. Limits of the work only: never how the paper was produced, drafted, reviewed or checked; no hedging and no apology.${s.outline!.sections.some((sec) => sec.id === id) ? ' The paper already has a Limitations section: return it whole, with what you add.' : ''} If the paper has no caveat at all, return limitations empty.`,
      context: limits.length ? `LIMITS OF THE WORK THE AUTHORS WERE LEFT DURING WRITING AND REVIEW (not yet in the paper):\n${limits.join('\n')}` : '',
      schema: { limitations: str() },
      extra: (reply, texts) => {
        const text = String(reply.limitations ?? '').trim().replace(/^#+\s*Limitations\s*\n+/i, '')
        texts.set(id, text)
        return selfTalk(text).map((sentence) => `This sentence of the limitations is a remark on how the paper was made, not a limit of the work: "${sentence}"`)
      },
    })
  }),
}

export const storyLead: Behavior = {
  id: 'story-lead', stage: 'close', improver: true, title: 'State the main findings first, and title the paper plainly',
  ready: (paper) => stepTarget(paper, 1, 'the main findings first, and the title', async () => {
    const first = bodySections(paper)[0]
    if (!first) return
    const own = titleIsTheAuthors(paper)
    const field = paper.state.brief?.field
    await tell(paper, {
      behavior: 'story-lead', what: 'stating the main findings first and titling the paper', parts: [{ id: 'title', head: 'Title', text: titleOf(paper) }, ...partsOf(paper, false)],
      editable: new Set([first.id]),
      task: `Your task: the beginning and the title.
- The paper's main findings come first. Rewrite the opening of the introduction ([${first.id}]) so that its first paragraph states what the paper finds, plainly and specifically, with the key numbers ({{placeholders}} where the paper states them so), before any background or definition. The rest of the introduction then takes the reader from the problem to how the paper reaches these findings; what the new opening displaces moves to where it fits, said once.
- A main finding is a result the paper establishes, in the words and with the strength and the conditions its results section gives it: not a promise, a method or a list of sections.
- ${own ? 'The authors set the title: return it as title, unchanged.' : `title: a reader in the field${field ? ` (${field})` : ''} understands it without reading the paper. It says what the paper finds or provides, in words the field already uses; a term the paper itself coins appears in it only where the title's own words make it clear. At most 15 words. Return the current title if it already does this.`}`,
      schema: { title: str() },
      extra: (reply, texts) => {
        const title = String(reply.title ?? '').trim().replace(/^["“]|["”]$/g, '')
        if (!own && title) texts.set('title', title)
        return !own && title && title.split(/\s+/).length > 15 ? [`the title has ${title.split(/\s+/).length} words; at most 15`] : []
      },
    })
  }),
}

export const storyExample: Behavior = {
  id: 'story-example', stage: 'close', improver: true, title: 'Work one example through',
  ready: (paper) => stepTarget(paper, 2, 'a worked example', async () => {
    const parts = partsOf(paper, false).filter((p) => p.id !== limitsId(paper))
    const record = productionRecord(paper)
    const numbers = Object.entries(record).filter(([key]) => key.startsWith('sim.') || key.startsWith('data.'))
    await tell(paper, {
      behavior: 'story-example', what: 'working one example through', parts,
      editable: new Set(bodySections(paper).map((sec) => sec.id)),
      task: `Your task: a worked example. The paper carries at least one: one concrete case taken through the paper's method from its inputs to its result, step by step, so a reader sees exactly how a result of the paper arises and could repeat the steps by hand.
- Choose the case that best shows the main result: a setting the paper itself uses (one of its runs, a measured case, the parameters of a proposition). If the paper already works a case through, make that one complete and easy to follow instead (its inputs named, each step shown, the result tied to the claim it illustrates), and return present true.
- Place it where the reader needs it: where the method is first applied, or beside the main result; as its own paragraph or paragraphs, introduced as an example. A few sentences of plain working, not a new section of theory.
- Use only the paper's own definitions, data and results. A number the paper states keeps its form, its {{placeholder}} included. Every number the example works out is shown with its working in the text, and listed in calculations: expression, the arithmetic that gives it (numbers, + - * / ^, parentheses, log10, log, sqrt, exp, min, max, and {{placeholders}} for recorded numbers), and value, the number exactly as the example writes it. Each one is checked.
- No new data, measurement, simulation or claim: the example shows what the paper already establishes.`,
      context: numbers.length ? `RECORDED NUMBERS, for calculations: ${numbers.slice(0, 400).map(([key, value]) => `{{${key}}} = ${value}`).join('; ')}` : '',
      schema: { present: bool(), calculations: arr(obj({ expression: str(), value: str() })) },
      extra: (reply, texts, rec) => {
        const changed = [...texts.entries()].filter(([id, text]) => text !== parts.find((p) => p.id === id)?.text).map(([, text]) => fillPlaceholders(text, rec).text).join('\n')
        const squash = (t: string) => t.replace(/[   ,]/g, '')
        const problems: string[] = []
        for (const c of reply.calculations ?? []) {
          const wrong = checkCalculation(String(c.expression ?? ''), String(c.value ?? ''), rec)
          if (wrong) problems.push(`calculation ${c.expression} = ${c.value}: ${wrong}`)
          else if (!squash(changed).includes(squash(String(c.value ?? '')))) problems.push(`the worked value ${c.value} is not written in the example`)
        }
        if (!reply.present && !changed) problems.push('no example was worked through')
        return problems
      },
    })
  }),
}

export const storyRegister: Behavior = {
  id: 'story-register', stage: 'close', improver: true, title: 'One language and one register',
  ready: (paper) => stepTarget(paper, 3, 'one language and one register', async () => {
    const parts = partsOf(paper, false)
    const about = Boolean(paper.state.brief?.aboutSystem)
    // What the paper says of its own making is found by code, and goes, whoever wrote it.
    const talk = parts.flatMap((p) => madeTalk(p.text, about).map((sentence) => `- [${p.id}] "${sentence}"`))
    const review = paper.state.literature?.status === 'done'
    await tell(paper, {
      behavior: 'story-register', what: 'making the language and register one throughout', parts,
      editable: new Set(parts.map((p) => p.id)),
      task: `Your task: one language and one register. The paper was drafted section by section and revised by several hands; make it read as one author wrote it, in the field's formal register:
- the same register in every section and caption: none more conversational, more terse, more ornate or more technical in its prose than the rest;
- one voice: the same person (we) or the same impersonal construction throughout, and the same tense conventions (what the paper does in the present, what was done in the past), as the field writes them;
- one name for each concept, method, quantity and unit, the one the paper defines, used the same way everywhere;
- one way of doing the same thing: introducing a definition, reporting a result, referring to a figure or a table;
- internal labels (run names such as S1, section numbers standing in for names) only where the reader needs them to find something; elsewhere, the thing's name.${talk.length ? `
- These sentences speak of how the paper was made, which the paper never does outside its section on the use of AI. Rewrite each so that it states the work itself (its method, its data, its sources), or remove it where it says nothing else:
${talk.join('\n')}` : ''}${review ? `
- The paper's literature review screened the records that covered most of its question, not every record its searches found: it is a targeted review, not a systematic review in the formal sense. Wherever the paper names it, name it so, and where the paper reports it, say plainly that it is not a systematic review in the formal sense${paper.config.literatureReview === 'load-bearing' ? ', though the paper rests on it' : ''}.` : ''}
Leave alone what already reads as one; return no edits when the whole paper does.`,
    })
  }),
}

/** Rewrites the figure numbers a text refers to, so each reference still names the figure it named. */
export function renumber(text: string, map: Map<number, number>): string {
  if (![...map].some(([from, to]) => from !== to)) return text
  return text.replace(/\b(Figures?)(\s+)(\d+)((?:\s*(?:,|and|or|to|–)\s*\d+)*)/g, (_m, word: string, space: string, first: string, rest: string) =>
    `${word}${space}${map.get(Number(first)) ?? first}${rest.replace(/\d+/g, (d) => String(map.get(Number(d)) ?? d))}`)
}

const panelSchema = obj({
  kind: enm(['hist', 'line', 'interval']),
  data: arr(str(), 'references from the data list'),
  labels: arr(str(), 'what each reference is called in the chart, in the same order'),
  x: str('the horizontal axis label'), y: str('the vertical axis label'),
  unit: str('the unit of the measured quantity as the paper writes it; "1" for a pure number'),
  x_unit: str('for a line chart, the unit of its horizontal axis; otherwise empty'),
  marks: arr(obj({ axis: enm(['x', 'y']), value: num(), label: str() })),
})

function panelsOf(raw: any[]): ChartPanel[] {
  return (raw ?? []).slice(0, 4).map((p: any) => ({
    kind: p.kind, data: (p.data ?? []).map(String), labels: (p.labels ?? []).map(String), x: String(p.x ?? ''), y: String(p.y ?? ''),
    unit: String(p.unit ?? '1') || '1', ...(p.x_unit ? { xUnit: String(p.x_unit) } : {}),
    marks: (p.marks ?? []).filter((m: any) => Number.isFinite(m?.value)).slice(0, 2).map((m: any) => ({ axis: m.axis === 'y' ? 'y' : 'x', value: Number(m.value), label: String(m.label ?? '') })),
  }))
}

/** A chart's panels are drawable here when every reference is data of this paper that its kind can draw, and every mark is a value the text states. */
function chartProblems(paper: Paper, panels: ChartPanel[], kinds: ChartPanel['kind'][], text: string): string[] {
  const catalog = new Map(chartCatalog(paper).map((d) => [d.ref, d]))
  const problems: string[] = []
  if (!panels.length) problems.push('it has no panel')
  for (const panel of panels) {
    if (!kinds.includes(panel.kind)) problems.push(`${panel.kind} is not a kind galley draws here`)
    for (const ref of panel.data) if (!catalog.get(ref)?.kinds.includes(panel.kind)) problems.push(`${ref} is not data a ${panel.kind} panel of this paper can draw`)
    for (const mark of panel.marks) if (!new RegExp(`(^|[^\\d.])${String(mark.value).replace('.', '\\.')}([^\\d]|$)`).test(text)) problems.push(`the mark at ${mark.value} is not a value the text states`)
  }
  return problems
}


/** What the author is asked when the charts are planned: the parts that gain from one, drawn only from data the paper holds. */
function chartsPrompt(paper: Paper, kinds: ChartPanel['kind'][], data: ReturnType<typeof chartCatalog>, parts: Part[], record: Record_): string {
  const about: Record<ChartPanel['kind'], string> = {
    hist: 'hist (the distribution of a simulated quantity over its draws; one to three, overlaid, of the same quantity in different runs)',
    line: 'line (a course over time with its band; one to three)',
    interval: 'interval (estimates with their intervals side by side, one row each; two to twelve)',
  }
  const figures = printedOrder(paper)
  return `${HOUSE}

${STYLE}

${STORY}

Your task: the charts. Find the parts of the paper that gain most from a chart: where the text asks the reader to hold several numbers in mind, to compare estimates, or to picture a distribution or a course over time that it states in words. A chart shows what the text states; it adds no result.
- At most ${MAX_CHARTS} data charts in the paper, counting those it has. A chart may replace an existing figure that charts data (give its id as replaces: it keeps its number and its place); drawings of a structure stay as they are.
- Each chart has one to four panels, each of one kind: ${kinds.map((k) => about[k]).join('; ')}. Several panels make a grid, for views of one result that belong side by side.
- A panel draws only the data listed below, by its reference: never a number typed in.
- labels: what each reference is called in the chart (a run's setting, a group), in the paper's words, never an internal id. x and y: the axis labels, named as the paper names the quantities. unit: the unit of the measured quantity as the paper writes it.
- marks: at most two reference lines a panel needs (a threshold, a floor), each at a value the text states, with a short label.
- caption: what the chart shows and how to read it, at most 50 words, in the paper's terms; a number in it is written as its {{placeholder}}.
- section: the id of the section it belongs in. mention: an exact edit in that section that refers the reader to the chart where the text discusses what it shows, writing the chart as [[chart-1]], [[chart-2]], … in the order you list the charts; it prints as its figure number. A chart that replaces a figure needs no mention.
If no part of the paper gains from a chart, return no charts.

DATA:
${data.map((d) => `- ${d.ref} (${d.kinds.join(' or ')}): ${d.about}`).join('\n')}

FIGURES THE PAPER HAS:
${figures.length ? figures.map((f, i) => `- [${f.id}] Figure ${i + 1} (${f.kind === 'chart' ? 'a chart' : 'a drawing'}, in ${f.sectionId}): ${fillPlaceholders(f.caption, record).text}`).join('\n') : 'none'}

THE PAPER:
${block(parts, new Map(parts.map((p) => [p.id, p.text])), null)}`
}
export const storyCharts: Behavior = {
  id: 'story-charts', stage: 'close', improver: true, title: 'Chart what the argument rests on',
  ready: (paper) => {
    const s = paper.state
    const targets: Target[] = []
    // A chart a reader sent back is drawn again, its data unchanged: only its design answers the defect.
    for (const fig of s.figures.filter((f) => f.kind === 'chart' && f.status === 'planned' && f.chart)) {
      targets.push({
        key: `chart:${fig.id}:redraw${fig.redraws ?? 1}`, label: `chart ${fig.id}, drawn again`,
        run: async () => {
          const reply = await paper.ask<any>({
            behavior: 'story-charts', target: `redraw-${fig.id}`, seat: 'author', family: seatFamily(paper, 'author'),
            prompt: `${HOUSE}\n\nIn the typeset paper, a reader found this in a chart: ${fig.revise}\nRevise the chart's design to answer it: its axis labels, units, labels, marks or panels. Its data stay the same references. caption: the caption as it should print, at most 50 words, unchanged unless the defect is in it.\n\nTHE CHART:\n${JSON.stringify({ caption: fig.caption, panels: fig.chart!.panels })}`,
            schema: obj({ caption: str(), panels: arr(panelSchema) }),
          })
          const panels = panelsOf(reply.panels).map((p, i) => ({ ...p, data: fig.chart!.panels[i]?.data ?? p.data }))
          const drawn = await drawChart(paper, { ...fig, chart: { ...fig.chart!, panels } }, `redraw${fig.redraws ?? 1}`)
          fig.status = 'rendered'
          if (!drawn.ok) { paper.note('story-charts', `Chart ${fig.id} could not be drawn again (${drawn.problem}); it prints as it was.`); paper.save(); return }
          Object.assign(fig, { file: drawn.file, source: drawn.source, chart: { ...fig.chart!, panels, bundle: drawn.bundle } })
          if (String(reply.caption ?? '').trim()) fig.caption = String(reply.caption).trim()
          delete fig.revise
          paper.save()
        },
        skip: () => { fig.status = 'rendered' },
      })
    }
    return [...targets, ...stepTarget(paper, 4, 'the charts', async () => {
      const cmd = astetikCommand()
      const astetik = cmd ? await astetikCatalog(cmd) : null
      const kinds = astetik ? drawable(astetik) : []
      const data = chartCatalog(paper)
      if (!kinds.length || !data.length) {
        paper.note('story-charts', !kinds.length ? 'No charts: Astetik is not installed here, or draws none of the kinds galley uses.' : 'No charts: the paper has no simulated or measured data to chart.')
        return
      }
      const parts = partsOf(paper, false)
      const record = productionRecord(paper)
      const reply = await paper.ask<any>({
        behavior: 'story-charts', target: 'plan', seat: 'author', family: seatFamily(paper, 'author'),
        prompt: chartsPrompt(paper, kinds, data, parts, record),
        schema: obj({ charts: arr(obj({ section: str(), replaces: str(), purpose: str(), caption: str(), panels: arr(panelSchema), mention: obj({ old: str(), new: str() }) })) }),
      })
      const text = fillPlaceholders(parts.map((p) => p.text).join('\n'), record).text
      const numbersBefore = new Map(printedOrder(paper).map((f, i) => [f.id, i + 1]))
      const taken = new Set(s.figures.map((f) => f.id))
      const drawn: { fig: Figure; token: string; mention: Edit; added: boolean }[] = []
      for (const [i, raw] of (reply.charts ?? []).slice(0, MAX_CHARTS).entries()) {
        const panels = panelsOf(raw.panels)
        const replaced = s.figures.find((f) => f.id === String(raw.replaces ?? '').trim() && f.status === 'rendered' && f.file)
        const section = replaced ? undefined : bodySections(paper).find((sec) => sec.id === String(raw.section ?? '').replace(/[[\]]/g, '').trim())
        const token = `[[chart-${i + 1}]]`
        const mention = { old: String(raw.mention?.old ?? ''), new: String(raw.mention?.new ?? '') }
        const problems = chartProblems(paper, panels, kinds, text)
        if (!replaced && !section) problems.push('it names no section of the paper')
        // A new chart is placed only where the text refers to it; a replaced one keeps the references it had.
        else if (!replaced && (!mention.new.includes(token) || applyExact(sectionText(paper, section!.id), mention) === null)) problems.push('the text could not be made to refer to it')
        if (problems.length) { paper.note('story-charts', `A chart was left out: ${problems.slice(0, 3).join('; ')}.`); continue }
        let id = replaced?.id
        if (!id) { let k = 1; while (taken.has(`chart${k}`)) k++; id = `chart${k}`; taken.add(id) }
        const plan: ChartPlan = { purpose: String(raw.purpose ?? ''), panels, ...(replaced ? { replaces: replaced.id } : {}) }
        const fig: Figure = { id, caption: String(raw.caption ?? '').trim() || replaced?.caption || '', spec: plan.purpose, sectionId: replaced?.sectionId ?? section!.id, status: 'planned', kind: 'chart', chart: plan }
        const result = await drawChart(paper, fig, 'draw1')
        if (!result.ok) { paper.note('story-charts', `A chart was left out: ${result.problem}.`); continue }
        Object.assign(fig, { status: 'rendered', file: result.file, source: result.source, chart: { ...plan, bundle: result.bundle } })
        drawn.push({ fig, token, mention, added: !replaced })
      }
      if (!drawn.length) return
      // A replaced figure keeps its place and number; a new chart prints after the figures already in its section.
      for (const d of drawn) {
        const at = s.figures.findIndex((f) => f.id === d.fig.id)
        if (at >= 0) s.figures[at] = { ...s.figures[at], ...d.fig, revise: undefined }
        else s.figures.push(d.fig)
      }
      const numbersAfter = new Map(printedOrder(paper).map((f, i) => [f.id, i + 1]))
      const map = new Map([...numbersBefore].map(([id, n]) => [n, numbersAfter.get(id) ?? n]))
      for (const d of drawn) d.fig.caption = renumber(d.fig.caption, map)
      const original = new Map(parts.map((p) => [p.id, p.text]))
      const renumbered = new Map([...original].map(([id, t]) => [id, renumber(t, map)]))
      const texts = new Map(renumbered)
      for (const d of drawn.filter((x) => x.added)) {
        const mention = { old: renumber(d.mention.old, map), new: renumber(d.mention.new, map).split(d.token).join(`Figure ${numbersAfter.get(d.fig.id)}`) }
        const after = applyExact(texts.get(d.fig.sectionId) ?? '', mention)
        if (after !== null) texts.set(d.fig.sectionId, after)
      }
      // A reference added must not take anything the research rests on with it.
      for (const [id] of researchLost(renumbered, texts, record)) texts.set(id, renumbered.get(id)!)
      commit(paper, texts, original, 'story-charts')
      paper.journal({ event: 'story', step: 'story-charts', charts: drawn.map((d) => d.fig.id) })
      paper.save()
    })]
  },
}

/** The read-throughs: after the final frame, the whole paper is read as a reader meets it, and what still gets in the way is cleaned up. */
export const storyRead: Behavior = {
  id: 'story-read', stage: 'close', improver: true, title: 'Read the told paper through',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || s.outcome || !s.outline || !s.frame || !paper.isSettled('frame:final')) return []
    const n = Array.from({ length: READS }, (_, i) => i + 1).find((i) => !paper.isSettled(`story:read:${i}`))
    if (!n || (n > 1 && !paper.isSettled(`story:read:${n - 1}`))) return []
    return [{
      key: `story:read:${n}`, label: `the paper read through, ${['once', 'a second time', 'a third time'][n - 1] ?? `time ${n}`}`,
      run: async () => {
        const record = productionRecord(paper)
        const parts = partsOf(paper, true)
        const texts = new Map(parts.map((p) => [p.id, p.text]))
        // Each reading by a different pair of eyes where the families allow: the checker, then the challenger, in turn.
        const reader = n % 2 === 0 ? seatFamily(paper, 'challenger') : seatFamily(paper, 'checker')
        const found = await paper.ask<any>({
          behavior: 'story-read', target: `read-${n}`, seat: n % 2 === 0 ? 'challenger' : 'checker', family: reader,
          prompt: `${HOUSE}

You are reading a finished paper in your field from its title to its last section, as a careful reader meets it. Its research is done and reviewed and stays as it is. Report what still makes it harder to follow than it needs to be:
- unnecessary complication: a sentence or passage that makes the reader work harder than its content needs (stacked qualifications, nested definitions, labels where names would do, a detour from the line of the argument);
- incoherence: a passage that does not follow from the one before it, a term or symbol used before it is explained, a point made twice in different words, an order that makes the reader wait for what they need;
- tension: the paper pulling two ways (a finding stated more strongly in one place than in another, a title or abstract that promises what the body does not deliver, a figure and the text that disagree, a caveat outside the Limitations section, a sentence on how the paper itself was made).
For each, give where (the id in brackets of the part), quote (copied exactly from it), problem, and fix (what it should say instead). Report what a careful reader in the field would want changed, and only that; if the paper reads cleanly, return no problems.

THE PAPER:
${block(parts, texts, record)}`,
          schema: obj({ problems: arr(obj({ where: str(), quote: str(), problem: str(), fix: str() })) }),
        })
        const ids = new Set(parts.map((p) => p.id))
        const problems = (found.problems ?? []).map((p: any) => ({ ...p, where: String(p.where ?? '').replace(/[[\]]/g, '').trim() })).filter((p: any) => ids.has(p.where) && String(p.problem ?? '').trim())
        paper.journal({ event: 'story-read', reading: n, family: reader, problems: problems.length })
        if (!problems.length) return
        await tell(paper, {
          behavior: 'story-read', what: `cleaning up what a reader found on reading ${n}`, parts,
          editable: new Set(parts.map((p) => p.id).filter((id) => id !== 'title' || !titleIsTheAuthors(paper))),
          task: `A reader in the field read the paper through and found these places harder to follow than they need to be. Clean each one up with exact edits, keeping the research as it is; where a fix would change what the paper claims, finds or cites, leave the place as it is.
${problems.map((p: any, i: number) => `${i + 1}. [${p.where}] "${p.quote}": ${p.problem} Fix: ${p.fix}`).join('\n')}`,
        })
      },
      skip: () => {},
    }]
  },
}
