// Rendering: the state becomes a Pandoc manuscript and, through Typst, a PDF,
// plus LaTeX, Word, the editor's document with its notes, the sign-off sheet,
// the production record and a Resolvent evidence package.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claim, keyFor, ledgerAppendix } from './behaviors/common.js'
import { FAMILY_NAMES, lightName, lightSpecFor } from './config.js'
import { cleanCsl, completeByTitle, cslForDoi, cslFromWork, titleWords } from './evidence.js'
import type { Paper } from './paper.js'
import { LIT_PLACEHOLDERS, modelName, reviewAppendix, reviewFlowTypst } from './literature.js'
import { worldModelOf } from './worldmodel.js'
import { availabilityStatement, datasetSources, describeData } from './materials.js'
import { methodWords, runsOf, sizeOf } from './simulations.js'
import { writeReproduction } from './simulation/index.js'
import { PLACEHOLDERS } from './prompts.js'
import { fillPlaceholders, productionRecord, type Record_ } from './record.js'
import { software, sourceStatement } from './self.js'
import { escapeUnknownCitations, squash } from './text.js'
import type { Annotation, AnnotationAuthor, AnnotationLabel, AnnotationReply } from '../types.js'
import type { AuthorNote, Claim, Family, Finding, Work } from './types.js'

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { cwd, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${stderr || error.message}`)) : resolve(stdout)))
}

// ---------------------------------------------------------------- references

async function references(paper: Paper): Promise<{ refs: Record<string, unknown>[]; aliases: Map<string, string> }> {
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []
  // One work found twice (a document from the web and its record in the index, a preprint and its journal version) is
  // listed once: every key it was cited under prints the first entry.
  const aliases = new Map<string, string>()
  const firstBy = new Map<string, string>()
  const add = async (work: Work) => {
    const key = keyFor(paper, work)
    if (seen.has(key)) return
    seen.add(key)
    // A document found on the web is cited as the publication it is, when the index holds one by its exact title:
    // its issuer is not its author, and the day it was read is not when it was published.
    if (work.id.startsWith('web:') && !work.titleChecked) {
      work.titleChecked = true
      if (await completeByTitle(work, true)) delete work.csl
    }
    // A reference that would print as only a title, a year and a link is looked up once by its title.
    if (!work.csl && !work.doi && (!work.authors.length || !work.venue) && !work.titleChecked) {
      work.titleChecked = true
      await completeByTitle(work)
    }
    if (!work.csl && work.doi) {
      const csl = await cslForDoi(work.doi)
      if (csl) work.csl = csl
    }
    const title = titleWords(work.title)
    const ids = [work.doi ? `doi:${work.doi.toLowerCase()}` : '', title.length >= 4 ? `title:${title.join(' ')}` : ''].filter(Boolean)
    const first = ids.map((id) => firstBy.get(id)).find(Boolean)
    if (first) {
      aliases.set(key, first)
      return
    }
    for (const id of ids) firstBy.set(id, key)
    out.push({ ...cleanCsl(work.csl ?? cslFromWork(work)), id: key })
  }
  for (const cite of paper.state.citations.filter((c) => c.status === 'verified')) {
    const work = paper.state.works[cite.workId]
    if (work) await add(work)
  }
  // Every publication a systematic review included is listed in its appendix, and each dataset is cited where it is
  // described, so each one is in the references too.
  // So is every work the text names.
  const datasets = (paper.config.datasets ?? []).flatMap((unit) => Object.values(datasetSources(paper, unit))).map((workId) => ({ workId }))
  for (const { workId } of [...(paper.state.literature?.status === 'done' ? paper.state.literature.included ?? [] : []), ...datasets, ...(paper.state.named ?? [])]) {
    const work = paper.state.works[workId]
    if (work) await add(work)
  }
  paper.save()
  return { refs: out, aliases }
}

// ---------------------------------------------------------------- manuscript

const yamlString = (text: string) => JSON.stringify(text)

function unplacedNames(paper: Paper, known: Set<string>): string[] {
  const keys = [...new Set((paper.state.named ?? []).filter((n) => !n.placed && paper.state.works[n.workId]).map((n) => keyFor(paper, paper.state.works[n.workId])))].filter((key) => known.has(key))
  return keys.length ? [`nocite: ${yamlString(keys.map((key) => `@${key}`).join(', '))}`] : []
}

/** Every pipe table in Markdown has one rule line under its header, and Typst numbers every table, so this counts them. */
export const tablesIn = (markdown: string) => (markdown.match(/^\|(?:\s*:?-+:?\s*\|)+\s*$/gm) ?? []).length

/** Who wrote the seed, as the byline has them: one author or several (possessive: whose machine). */
function theAuthors(paper: Paper, possessive = false): string {
  const many = paper.config.authors.length > 1
  return possessive ? (many ? 'the authors’' : 'the author’s') : (many ? 'the authors' : 'the author')
}

function disclosure(paper: Paper, record: Record_, table = 1): string {
  const seats = paper.config.seats
  const referees = [...new Set(paper.config.referees.map((r) => r.family))].map((f) => FAMILY_NAMES[f]).join(' and ')
  const lit = paper.state.literature?.status === 'done' ? paper.state.literature : null
  const everyCitation = lit ? 'every citation outside the systematic review' : 'every citation'
  // Answering, judging and settling single findings run on the lighter settings; the statement names them.
  const settling = [...new Set([seats.author, ...paper.config.referees.map((r) => r.family)])].map((f) => lightName(lightSpecFor(paper.config, f)))
  const settled = paper.state.round >= 1 ? ` A first answer to a finding and the first verdict on it ran on lighter reasoning settings (${settling.join(', ')}); later answers, second verdicts and every adjudication ran at full effort.` : ''
  // Primary sources from the web, when any is cited.
  const web = paper.state.citations.filter((c) => c.status === 'verified' && c.workId.startsWith('web:')).length
  const fromWeb = web ? ` Where the scholarly index had no source for a claim, GPT-6.2 Sol searched the web for the primary document (the issuer's own rules, standards, specifications or reports); galley fetched and kept a copy of each, and each of the ${web} citation${web === 1 ? '' : 's'} to such documents was verified against its passage like any other.` : ''
  const sims = runsOf(paper)
  const simulated = sims.length ? ` The Monte Carlo simulation${sims.length > 1 ? 's' : ''} (${sims.map((r) => `${r.id}, ${methodWords(r.result.method)} with ${sizeOf(r.result)}, seed ${r.result.provenance.seed}`).join('; ')}) ran on ${theAuthors(paper, true)} machine with galley's simulation engine, from a specification ${FAMILY_NAMES[seats.author]} wrote; every simulated number in the text is filled in from that run at the precision its Monte Carlo error supports, and the evidence package holds each specification with its results, so every number can be reproduced.` : ''
  const review = lit ? ` The systematic review ${paper.config.literatureReview === 'load-bearing' ? 'this paper reports' : 'reported in its own section'} was carried out with Canary: ${modelName(lit.models?.research)} planned the search of OpenAlex, screened the candidates, read the full texts and quoted the passages behind each finding, and ${modelName(lit.models?.audit)} audited every finding against those passages; the review's citations rest on them.` : ''
  // A paper built on a world model says so, and whether it searched anything else.
  const wm = paper.config.worldModel
  const sources = wm
    ? ` Its sources come from the world model "${wm.name}", a Resolvent world model of ${wm.claims.toLocaleString('en-US')} claims resting on the verbatim passages of ${wm.sources.toLocaleString('en-US')} sources${wm.only ? '; no other literature was searched' : ', searched first, and then the literature through Canary over OpenAlex'}. For each claim galley searched the world model's sources, and ${FAMILY_NAMES[seats.checker]} chose the passages, copied verbatim from each source's excerpt. Bibliographic records come from the DOI registries.`
    : ' Literature search ran through Canary over OpenAlex; bibliographic records come from the DOI registries.'
  return `This manuscript was produced with ${software()} from a seed text written by ${theAuthors(paper)}. ${FAMILY_NAMES[seats.author]} extracted the seed's claims, planned the argument, drafted every section and answered the referees. ${FAMILY_NAMES[seats.checker]} ${wm?.only ? 'selected candidate passages' : 'wrote the literature searches, selected candidate passages'} and checked each section against its claims. ${seats.challenger === seats.verifier ? `${FAMILY_NAMES[seats.challenger]} challenged the idea before drafting and verified ${everyCitation} against the passage it rests on.` : `${FAMILY_NAMES[seats.challenger]} challenged the idea before drafting, and ${FAMILY_NAMES[seats.verifier]} verified ${everyCitation} against the passage it rests on.`} Referee reports came from ${referees}, never from the family that drafted the text, and each answer to a material finding was verified by the referee family that raised it.${settled}${sources}${fromWeb}${review}${simulated} No model reviewed its own work. The production journal that accompanies this manuscript records every step, model call, verdict and decision with its time, and the evidence package holds each claim with the verbatim passage and verdict behind every citation. Table ${table} gives the run in numbers.

| Production record | |
|:---|:---|
| Model calls | ${record['run.calls']} (Claude ${record['run.calls_claude']}, GPT ${record['run.calls_gpt']}, Gemini ${record['run.calls_gemini']}) |
| Tokens | ${record['run.tokens_in_m']} M in, ${Number(record['run.tokens_out_k']) >= 1000 ? `${(Number(record['run.tokens_out_k']) / 1000).toFixed(1)} M` : `${record['run.tokens_out_k']} k`} out |
| Claims | ${record['run.claims']} (${record['run.claims_seed']} from the seed, ${record['run.claims_added']} added; ${record['run.claims_narrowed']} narrowed; ${record['run.claims_unsupported']} stated as hypotheses) |
| Works screened | ${record['run.works_screened']} |
| Citations | ${record['run.citations_verified']} verified, ${record['run.citations_rejected']} rejected |
${sims.length ? `| Simulations | ${sims.map((r) => `${r.id}: ${methodWords(r.result.method)}, ${sizeOf(r.result)}; ${r.result.provenance.ok ? 'every check passed' : `${r.result.provenance.checks.filter((c) => !c.ok).length} check(s) noted`}`).join('; ')} |\n` : ''}${lit ? `| Systematic review | ${record['lit.discovered']} records identified, ${record['lit.screened']} screened, ${record['lit.reviewed']} read in full and included; ${record['lit.findings']} findings, ${record['lit.audited']} audited |\n` : ''}| Referee findings | ${findingsSummary(record, theAuthors(paper))} |
| Verifier calibration | ${record['run.calibration'] === 'none to check' ? 'no verified citations to check' : `${record['run.calibration']} planted defective citations caught; ${record['run.calibration_controls']} unaltered controls accepted`} |

: The production record of this manuscript.
`
}

/**
 * Display equations are numbered in order, and a label the author gave one ({#eq:name}) becomes its number wherever
 * the text refers to it (@eq:name), so no label reaches the page as raw text.
 */
export function numberEquations(texts: string[]): string[] {
  const numbers = new Map<string, number>()
  let n = 0
  const numbered = texts.map((text) => text.replace(/\$\$([\s\S]*?)\$\$([ \t]*\{#eq:([\w:-]+)\})?/g, (_match, body: string, _label: string, name?: string) => {
    n++
    if (name) numbers.set(name, n)
    return `$$${body}$$`
  }))
  return numbered.map((text) => text
    .replace(/\[@eq:([\w:-]+)\]|@eq:([\w:-]+)/g, (match, a?: string, b?: string) => {
      const at = numbers.get((a ?? b)!)
      return at ? `(${at})` : match
    })
    .replace(/[ \t]*\{#eq:[\w:-]+\}/g, ''))
}

/** The systematic review's flow figure, drawn from Canary's counts when the paper is typeset. */
const REVIEW_FLOW = 'figures/review-flow.png'

/**
 * Typst settings both PDFs share: display equations carry their number, a heading never breaks a word across lines,
 * and a table is set a size smaller than the text and may run on to the next page (pandoc puts each table in a figure,
 * which otherwise cannot break, so a long table ran past the foot of the page and over itself).
 */
const TYPST_HEADER = [
  '#set math.equation(numbering: "(1)")',
  '#show heading: set text(hyphenate: false)',
  // A figure or table floats to the top or bottom of a page, so no page is left half empty in front of one, and a
  // table is never split; one too long for a page is let break, with its header repeated (see fitTables).
  '#show figure.where(kind: image): set figure(placement: auto)',
  '#show figure.where(kind: table): set figure(placement: auto)',
  '#show table: set text(size: 9pt)',
  '#show table: set par(justify: false)',
  // A paragraph or caption does not end on a line holding a single word.
  '#set text(costs: (runt: 500%))',
  // A display equation too wide for the column is set smaller until it fits beside its number.
  '#show math.equation.where(block: true): it => layout(size => {',
  '  let w = measure(math.equation(block: false, math.display(it.body))).width',
  '  let room = size.width - 4 * text.size',
  '  if w <= room { it } else { let f = room / w; scale(f * 100%, reflow: true, block(width: size.width / f, it)) }',
  '})',
].join('\n')

const UNITS = 'ns|µs|ms|s|min|h|Hz|kHz|MHz|GHz|mV|V|kV|mA|A|W|kW|MW|GW|Wh|kWh|MWh|J|kJ|K|°C|dB|dBm|B|kB|MB|GB|TB|ppm|%|mm|cm|m|km|g|kg'

/**
 * The text as a typesetter prints it, outside math and code:
 * - Single quotes are curly. Pandoc hands Typst straight quotes, and Typst opens a quote after a full stop or a plus
 *   sign, so "et al.'s" and "RSR++'s" printed with an opening quote. A quote after a space or an opening bracket opens;
 *   any other is an apostrophe or a closing quote. The PDF and Typst are written with pandoc's smart quotes off, so
 *   they stay as written.
 * - A number keeps its unit on the same line (a no-break space, which LaTeX and Word keep too).
 * - A negative number has a minus sign, not a hyphen.
 */
export function printedQuotes(text: string): string {
  const pattern = new RegExp(`(\\$\\$[\\s\\S]*?\\$\\$|\\$[^$\\n]+?\\$|\`[^\`\\n]*\`)|'|(?<=\\d) (?=(?:${UNITS})(?![\\p{L}\\d]))|(?<![\\p{L}\\d\\-–—.,/:])-(?=\\d)`, 'gu')
  return text.replace(pattern, (match: string, kept: string | undefined, at: number) => {
    if (kept) return kept
    if (match === ' ') return '\u00a0'
    // A negative number is printed with a minus sign, as it is in the mathematics beside it.
    if (match === '-') return '−'
    return /[\s([{“"—–/]/.test(text[at - 1] ?? ' ') ? '‘' : '’'
  })
}


/** About how many characters a cell or formula takes when printed: TeX commands and markup take none or one. */
export function printedLength(text: string): number {
  return text
    .replace(/\$([^$]*)\$/g, (_m, tex: string) => tex
      .replace(/\\(?:mathrm|mathbf|mathit|mathsf|mathcal|text|operatorname|overline|underline|hat|bar|tilde|widehat|left|right|bigl|bigr|Bigl|Bigr|big|Big|displaystyle|tfrac|dfrac|frac|quad|qquad)(?![a-zA-Z])/g, '')
      .replace(/\\[,;:! ]/g, '')
      .replace(/\\[a-zA-Z]+/g, 'x')
      .replace(/[{}^_\s&]/g, ''))
    .replace(/\[@[^\]]*\]/g, 'Author 2026')
    .replace(/\*\*|__|`/g, '')
    .trim().length
}


const STATEMENTS = 'Definition|Proposition|Theorem|Lemma|Corollary|Remark|Assumption|Conjecture|Example|Claim'

/**
 * The house conventions a typesetter applies to text drafted section by section:
 * - A numbered statement carries its name inside its bold label, as every other one does: "**Definition 7**
 *   (Concordance)." prints as "**Definition 7 (Concordance).**".
 * - A citation that a preposition makes a noun is the narrative form: "summarized in [@nist]" prints "summarized in
 *   NIST (2026)", not "summarized in (NIST 2026)".
 * - Sized delimiters are paired as \left and \right, which every format sizes to their contents; a size given alone is
 *   dropped. Pandoc draws \big( for Typst as a scaled box, which prints with gaps around it.
 */
export function conventions(text: string): string {
  return text
    .replace(new RegExp(`\\*\\*(${STATEMENTS}) (\\d+(?:\\.\\d+)*)\\*\\*\\s*\\(([^()\\n]{1,80})\\)\\.?`, 'g'), '**$1 $2 ($3).**')
    .replace(/(\b(?:in|by|from|of|following|per|with|than|to)) \[@([\w:.#$%&+?<>~/-]+)\]/g, '$1 @$2')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, (math) => {
      const opens = math.match(/\\(?:big|Big|bigg|Bigg)l(?![a-zA-Z])/g)?.length ?? 0
      const closes = math.match(/\\(?:big|Big|bigg|Bigg)r(?![a-zA-Z])/g)?.length ?? 0
      const paired = opens === closes ? math.replace(/\\(?:big|Big|bigg|Bigg)l(?![a-zA-Z])/g, '\\left').replace(/\\(?:big|Big|bigg|Bigg)r(?![a-zA-Z])/g, '\\right') : math
      return paired.replace(/\\(?:big|Big|bigg|Bigg)[lrm]?(?![a-zA-Z])\s*/g, '')
    })
}

// A table taller than this, as estimated from its cells, breaks across pages instead of floating whole.
const TALL_TABLE_CM = 17

/**
 * Pipe tables as the typesetter should lay them out. Pandoc gives each column the share of the width its dashes have in
 * the separator line, so the dashes are drawn in proportion to what each column holds: a column of symbols stays
 * narrow and the one that explains them gets the room. A table too tall for a page is let break across pages, its
 * header repeated, instead of floating whole (raw Typst around it; the other formats ignore it).
 */
/**
 * How a table's width is shared among its columns, given the printed length of each column's longest cell: each column
 * gets the room that cell needs on one line, at about 95 characters of 9pt text across the page. When they do not all
 * fit, the columns that need less than an even share keep what they need and the others share the rest evenly, so no
 * column is squeezed to a sliver beside one that stands half empty.
 */
export function columnShares(widths: number[]): number[] {
  const LINE = 95
  const need = widths.map((w) => w + 3)
  const room = need.map(() => 0)
  let open = need.map((_, c) => c)
  let left = LINE
  while (open.length) {
    const even = left / open.length
    const fits = open.filter((c) => need[c] <= even)
    if (!fits.length) {
      for (const c of open) room[c] = even
      break
    }
    for (const c of fits) {
      room[c] = need[c]
      left -= need[c]
    }
    open = open.filter((c) => need[c] > even)
  }
  const used = room.reduce((a, b) => a + b, 0)
  return room.map((r) => Math.max(0.08, r / used))
}

export function fitTables(markdown: string): string {
  const row = /^\|.*\|\s*$/
  const separator = /^\|(?:\s*:?-+:?\s*\|)+\s*$/
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/)
  const lines = markdown.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!(row.test(lines[i]) && separator.test(lines[i + 1] ?? ''))) { out.push(lines[i]); continue }
    let end = i + 2
    while (end < lines.length && row.test(lines[end])) end++
    const rows = [lines[i], ...lines.slice(i + 2, end)].map(cells)
    const aligns = cells(lines[i + 1]).map((a) => a.trim())
    const widths = aligns.map((_, c) => Math.max(4, ...rows.map((r) => printedLength(r[c] ?? ''))))
    const shares = columnShares(widths)
    const dashes = shares.map((share) => Math.max(3, Math.round(share * 60)))
    const rule = `|${aligns.map((a, c) => `${a.startsWith(':') ? ':' : ''}${'-'.repeat(dashes[c])}${a.endsWith(':') ? ':' : ''}`).join('|')}|`
    // Its height: each row as many lines as its fullest cell wraps to, at about 95 characters of 9pt text a line.
    const sum = shares.reduce((a, b) => a + b, 0)
    const height = rows.reduce((h, r) => h + 0.42 * (1 + Math.max(1, ...r.map((cell, c) => Math.ceil(printedLength(cell) / Math.max(4, 95 * shares[c] / sum))))), 0)
    const table = [lines[i], rule, ...lines.slice(i + 2, end)]
    // The caption, after the table or before it, stays with it.
    let after = end
    while (after < lines.length && !lines[after].trim()) after++
    const captionAfter = /^(?:Table)?:\s/.test(lines[after] ?? '')
    if (height <= TALL_TABLE_CM) {
      out.push(...table)
      i = end - 1
      continue
    }
    let before = out.length
    while (before > 0 && !out[before - 1].trim()) before--
    let start = before
    while (start > 0 && out[start - 1].trim()) start--
    const captionBefore = !captionAfter && /^(?:Table)?:\s/.test(out[start] ?? '')
    const lead = captionBefore ? out.splice(start) : []
    out.push('```{=typst}', '#[', '#show figure: set figure(placement: none)', '#show figure: set block(breakable: true)', '```', '', ...lead, ...table)
    if (captionAfter) {
      let last = after
      while (last < lines.length && lines[last].trim()) last++
      out.push(...lines.slice(end, last))
      end = last
    }
    out.push('', '```{=typst}', ']', '```')
    i = end - 1
  }
  return out.join('\n')
}

// A display whose formulas, set side by side, print longer than this is set one formula a line.
const WIDE_EQUATION = 60

/** The parts of a formula between separators at the top level, outside every brace. */
function topLevel(tex: string, separator: RegExp): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let at = 0; at < tex.length; at++) {
    const ch = tex[at]
    if (ch === '\\' && (tex[at + 1] === '{' || tex[at + 1] === '}')) { at++; continue }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (depth === 0 && ch === '\\') {
      const m = tex.slice(at).match(separator)
      if (m?.index === 0) {
        parts.push(tex.slice(from, at))
        from = at + m[0].length
        at = from - 1
      }
    }
  }
  parts.push(tex.slice(from))
  return parts
}

const RELATION = /(?<![\\<>!])(?:=|<|>)|\\(?:le|leq|ge|geq|approx|sim|equiv|propto)(?![a-zA-Z])/

/**
 * Two formulas set side by side in one display (`A, \qquad B`) that together print wider than the column are set one
 * above the other, aligned at their first relation, under the display's one number. A part that states no relation
 * (`\qquad \text{for all } i`) stays with the formula before it.
 */
export function splitWideEquations(text: string): string {
  return text.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex: string) => {
    if (/\\begin\{/.test(tex) || printedLength(`$${tex}$`) <= WIDE_EQUATION) return match
    const parts: string[] = []
    for (const part of topLevel(tex, /^\\qquad(?![a-zA-Z])/)) {
      if (parts.length && atTop(part, RELATION) < 0) parts[parts.length - 1] += ` \\qquad ${part.trim()}`
      else parts.push(part.trim())
    }
    if (parts.length < 2) return match
    const aligned = parts.map((part) => {
      const at = atTop(part, RELATION)
      return at > 0 ? `${part.slice(0, at)}&${part.slice(at)}` : `&${part}`
    })
    return `$$\n\\begin{aligned}\n${aligned.join(' \\\\\n')}\n\\end{aligned}\n$$`
  })
}

/** Where the first match of a pattern outside every brace starts, or -1. */
function atTop(tex: string, pattern: RegExp): number {
  let depth = 0
  for (let at = 0; at < tex.length; at++) {
    const ch = tex[at]
    if (ch === '\\' && (tex[at + 1] === '{' || tex[at + 1] === '}')) { at++; continue }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (depth === 0 && tex.slice(at).search(pattern) === 0) return at
  }
  return -1
}

export async function buildManuscript(paper: Paper): Promise<{ markdown: string; refs: Record<string, unknown>[]; record: Record_ }> {
  const s = paper.state
  const record = productionRecord(paper)
  const { refs, aliases } = await references(paper)
  // Escaped before quoting, so the backslash survives the YAML string.
  const known = new Set(refs.map((r) => String(r.id)))
  // A work listed once is cited by the one key it is listed under.
  const cited = (text: string) => [...aliases].reduce((t, [from, to]) => t.replace(new RegExp(`@${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:-])`, 'g'), `@${to}`), text)
  const plain = (text: string) => escapeUnknownCitations(printedQuotes(cited(text)), known)
  const title = paper.config.title || s.frame?.title || s.plan?.workingTitle || 'Untitled'
  // A paper never prints a blank for its author to fill: with none set it has no author line, and the sign-off asks for them.
  const authors = paper.config.authors
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const head = [
    '---',
    `title: ${yamlString(plain(title))}`,
    ...(authors.length ? ['author:'] : []),
    ...authors.map((a) => `  - name: ${yamlString(a.name)}${a.affiliation ? `\n    affiliation: ${yamlString(a.affiliation)}` : ''}${a.email ? `\n    email: ${yamlString(a.email)}` : ''}`),
    `date: ${yamlString(date)}`,
    `abstract: ${yamlString(plain(fillPlaceholders(s.frame?.abstract ?? '', record).text))}`,
    `keywords: [${(s.frame?.keywords ?? []).map((k) => yamlString(plain(k))).join(', ')}]`,
    'link-citations: true',
    'reference-section-title: References',
    // A work the text names where its words could not be found to cite it is still listed among the references.
    ...unplacedNames(paper, known),
    '---',
  ].join('\n')
  const body: string[] = []
  const unknown: string[] = []
  const sections = s.outline?.sections ?? []
  const numbered = numberEquations(sections.map((section) => s.passages[section.id]?.text ?? ''))
  for (const [i, section] of sections.entries()) {
    const filled = fillPlaceholders(numbered[i], record)
    unknown.push(...filled.unknown)
    body.push(`# ${section.title}\n\n${splitWideEquations(conventions(filled.text))}`)
    for (const fig of s.figures.filter((f) => f.sectionId === section.id && f.status === 'rendered' && f.file)) {
      // A caption can state a measured or simulated number, so it is filled like the text it sits in.
      body.push(`![${conventions(fillPlaceholders(fig.caption, record).text).replace(/\n/g, ' ')}](${fig.file}){#fig-${fig.id} width=95%}`)
    }
  }
  // Every figure and table of the body is printed before the back matter begins, and the back matter's own stand where
  // they are written: none drifts into the next part, nor into the references.
  body.push('```{=typst}\n#place.flush()\n#show figure: set figure(placement: none)\n```')
  const decl = paper.config.declarations ?? {}
  // The ledger quotes claims as they stand, placeholders included, so it is filled like every other part of the text.
  const appendices: [string, string][] = []
  if (paper.config.ledgerAppendix === true) appendices.push(['Claim ledger', fillPlaceholders(ledgerAppendix(paper), record).text])
  const described = describeData(paper)
  if (described) appendices.push(['The data', described])
  const flow = existsSync(paper.path('build', REVIEW_FLOW)) ? REVIEW_FLOW : null
  // The review's flow figure and tables come after every figure and table before them, and are referred to by number.
  const numbers = { figure: body.join('\n\n').match(/\]\([^)]*\)\{#fig-/g)?.length ?? 0, table: tablesIn([...body, ...appendices.map(([, text]) => text)].join('\n\n')) }
  const review = reviewAppendix(paper, (workId) => s.works[workId] ? `[@${keyFor(paper, s.works[workId])}]` : workId, flow, { figure: numbers.figure + 1, table: numbers.table + 1 })
  if (review) appendices.push(['The literature review: protocol, queries and included publications', review])
  appendices.forEach(([title, text], i) => body.push(`# Appendix ${String.fromCharCode(65 + i)}: ${title} {.unnumbered}\n\n${text}`))
  body.push(`# Use of AI and production record {.unnumbered}\n\n${disclosure(paper, record, tablesIn(body.join('\n\n')) + 1)}`)
  const evidencePackage = 'The claims of this manuscript, the evidence each rests on and the verbatim passages of its sources accompany it as a supplementary evidence package.'
  const reproduction = runsOf(paper).length ? ` The simulations can be rerun, and every simulated number checked against this manuscript, with the reproduction package that accompanies it (simulation/: \`node simulate.mjs --verify\`, or index.html in a browser).` : ''
  const data = availabilityStatement(paper)
  body.push(`# Data and code availability {.unnumbered}\n\n${decl.availability || `${data ? `${data} ` : ''}${s.brief?.aboutSystem ? `${sourceStatement()} ` : ''}${evidencePackage}${reproduction}`}`)
  // A declaration only the author can make is printed once they have made it; until then the sign-off asks for it.
  if (decl.competing_interests?.trim()) body.push(`# Competing interests {.unnumbered}\n\n${decl.competing_interests.trim()}`)
  if (decl.funding?.trim()) body.push(`# Funding {.unnumbered}\n\n${decl.funding.trim()}`)
  if (decl.acknowledgements?.trim()) body.push(`# Acknowledgements {.unnumbered}\n\n${decl.acknowledgements.trim()}`)
  body.push('# References {.unnumbered}\n\n::: {#refs}\n:::')
  if (unknown.length) paper.note('typeset', `Unknown placeholders left as "[not recorded]": ${[...new Set(unknown)].join(', ')}`)
  const printed = printedQuotes(fitTables(body.join('\n\n')))
  return { markdown: `${head}\n\n${escapeUnknownCitations(cited(printed), known)}\n`, refs, record }
}

// ---------------------------------------------------------------- editor document and notes

function annotationFor(lines: string[], quote: string, fallbackHeading: string): Annotation['range'] & { snippet: string } {
  const q = quote.trim()
  if (q.length >= 8) {
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i].indexOf(q)
      if (at >= 0) return { start_line: i, start_offset: at, end_line: i, end_offset: at + q.length, snippet: q }
    }
    // Fall back to the first dozen words, which often survive small edits.
    const short = q.split(/\s+/).slice(0, 12).join(' ')
    for (let i = 0; i < lines.length && short.length >= 8; i++) {
      const at = lines[i].indexOf(short)
      if (at >= 0) return { start_line: i, start_offset: at, end_line: i, end_offset: at + short.length, snippet: short }
    }
  }
  const heading = Math.max(0, lines.findIndex((line) => line.replace(/^#+\s*/, '') === fallbackHeading))
  return { start_line: heading, start_offset: 0, end_line: heading, end_offset: lines[heading]?.length ?? 0, snippet: lines[heading] ?? '' }
}

// In the editor every seat is a named colleague: the role, and the model behind it.
const TONES: Record<Family, AnnotationAuthor['tone']> = { claude: 'a', gpt: 'b', gemini: 'c' }
const agentAuthor = (name: string, family: Family): AnnotationAuthor => ({ name, kind: 'agent', detail: FAMILY_NAMES[family], tone: TONES[family] })
const refereeAuthor = (seat: string, family: Family) => agentAuthor(`${seat.charAt(0).toUpperCase()}${seat.slice(1)} referee`, family)
const ANSWER: Record<string, string> = { fixed: 'Fixed.', rebutted: 'Rebutted.', limitation: 'A limitation, left for you.', needs_evidence: 'Needs evidence.' }
const VERDICT: Record<string, string> = { verified: 'Verified the answer.', disagrees: 'Disagrees.', uncertain: 'Not sure yet.' }
const SETTLED: Record<string, string> = { fixed: 'Fixed', rebutted: 'Rebutted', limitation: 'Limitation', adjudicated: 'Settled', applied: 'Applied', noted: 'Noted', dropped: 'Dropped' }
const later = (iso: string | undefined, ms: number) => new Date((iso ? Date.parse(iso) : Date.now()) + ms).toISOString()
const byTime = (a: AnnotationReply, b: AnnotationReply) => a.created_at.localeCompare(b.created_at)
/** Replies galley did not write: a person's, which are never rewritten. */
const theirOwn = (replies: AnnotationReply[] = []) => replies.filter((r) => !r.id.startsWith('galley-'))

/** A finding's answers as replies in its thread: each answer, the referee's verdict on it, and a third family's decision. */
function answers(f: Finding): AnnotationReply[] {
  const out: AnnotationReply[] = []
  f.dispositions.forEach((d, k) => {
    const lead = ANSWER[d.kind]
    const text = d.text.trim()
    const opens = !!lead && text.toLowerCase().startsWith(lead.slice(0, -1).toLowerCase())
    out.push({ id: `galley-${f.id}-d${k}`, author: agentAuthor('Author', d.family), text: opens ? text.replace(/^([^.]+\.)/, '**$1**') : lead ? `**${lead}** ${text}` : text, created_at: d.at })
    if (d.verification) {
      const judge = f.origin === 'human' ? agentAuthor('Referee', d.verification.family) : refereeAuthor(f.seat, d.verification.family)
      out.push({ id: `galley-${f.id}-v${k}`, author: judge, text: `**${VERDICT[d.verification.outcome] ?? d.verification.outcome}** ${d.verification.reason}`, created_at: later(d.at, 1) })
    }
  })
  if (f.adjudication) out.push({ id: `galley-${f.id}-adj`, author: agentAuthor('Adjudicator', f.adjudication.family), text: f.adjudication.decision, created_at: later(f.dispositions.at(-1)?.at ?? f.at, 2) })
  return out
}

/** What the agents answered to a person's replies in a thread. */
function childAnswers(paper: Paper, parentId: string): AnnotationReply[] {
  return paper.state.findings.filter((c) => c.parent === parentId).flatMap((c) => answers(c))
}

/** A finding settled as a limitation: never written into the paper, it stays beside the text for the authors. */
const leftForAuthors = (f: Finding) => f.status === 'limitation' || (f.status === 'adjudicated' && !!f.adjudication?.decision.startsWith('limitation'))

function findingLabels(paper: Paper, f: Finding, resolved: boolean): AnnotationLabel[] {
  const waiting = (paper.state.proposals ?? []).some((p) => p.findingId === f.id && p.state === 'pending')
  const labels: AnnotationLabel[] = [f.severity === 'critical' ? { text: f.severity, tone: 'failed' } : { text: f.severity }]
  if (leftForAuthors(f)) labels.push({ text: 'limitation · for you', tone: 'attention' })
  else if (waiting) labels.push({ text: 'change waits for you', tone: 'attention' })
  else if (resolved) labels.push({ text: SETTLED[f.status] ?? f.status, tone: 'done' })
  else if (f.assignee !== 'agents') labels.push({ text: 'needs you', tone: 'attention' })
  else labels.push({ text: f.dispositions.length ? 'answered' : 'open' })
  return labels
}

/** A referee's finding as a thread: the question opens it, every answer follows, and a person's replies keep their place. */
function findingThread(paper: Paper, f: Finding, lines: string[], fallbackHeading: string, existing: Annotation | undefined): Annotation {
  const waiting = (paper.state.proposals ?? []).some((p) => p.findingId === f.id && p.state === 'pending')
  // A limitation stays open beside the text until a person resolves it there.
  const resolved = leftForAuthors(f) ? !!existing?.resolved : !!SETTLED[f.status] && !waiting
  // A note the editor has placed keeps its place: the editor re-finds passages as the text changes.
  const place = existing
    ? { range: existing.range, snippet: existing.snippet }
    : (({ snippet, ...range }) => ({ range, snippet }))(annotationFor(lines, f.quote, fallbackHeading))
  // Findings from older runs carry no time of their own: the first answer bounds it.
  const at = existing?.created_at ?? f.at ?? (f.dispositions[0] ? later(f.dispositions[0].at, -60_000) : new Date().toISOString())
  const replies = [...answers(f), ...childAnswers(paper, f.id), ...theirOwn(existing?.replies)].sort(byTime)
  const note: Annotation = {
    id: `galley-${f.id}`, ...place,
    comment: f.alternatives ? `${f.question}\n\n${f.alternatives}` : f.question,
    created_at: at, updated_at: replies.at(-1)?.created_at ?? at,
    author: refereeAuthor(f.seat, f.family),
    labels: findingLabels(paper, f, resolved),
  }
  if (replies.length) note.replies = replies
  if (resolved) note.resolved = true
  return note
}

const NOTE_KIND: Record<AuthorNote['kind'], string> = { unverified: 'no verified source', limitation: 'limitation', caution: 'caution' }

/** A note an agent left for the authors: a comment beside the passage it concerns, never printed, theirs to resolve. */
function authorNoteThread(paper: Paper, n: AuthorNote, lines: string[], fallbackHeading: string, existing: Annotation | undefined): Annotation {
  const place = existing
    ? { range: existing.range, snippet: existing.snippet }
    : (({ snippet, ...range }) => ({ range, snippet }))(annotationFor(lines, n.quote, fallbackHeading))
  const replies = [...theirOwn(existing?.replies), ...childAnswers(paper, `note-${n.id}`)].sort(byTime)
  const note: Annotation = {
    id: `galley-note-${n.id}`, ...place, comment: n.text, created_at: n.at, updated_at: replies.at(-1)?.created_at ?? n.at,
    author: agentAuthor(`${n.seat.charAt(0).toUpperCase()}${n.seat.slice(1)}`, n.family), labels: [{ text: NOTE_KIND[n.kind], tone: 'attention' }],
  }
  if (replies.length) note.replies = replies
  if (existing?.resolved) note.resolved = true
  return note
}

/** A person's own note, with what the agents answered. Its words, place and resolution stay theirs. */
function withAnswers(paper: Paper, note: Annotation): Annotation {
  const own = paper.state.findings.find((f) => f.id === `H-${note.id}`)
  const replies = [...theirOwn(note.replies), ...(own ? answers(own) : []), ...childAnswers(paper, `H-${note.id}`)].sort(byTime)
  const out: Annotation = { ...note }
  delete out.replies
  delete out.labels
  if (replies.length) out.replies = replies
  if (own) {
    out.labels = [own.assignee === 'humans' ? { text: 'yours' }
      : SETTLED[own.status] ? { text: 'answered', tone: 'done' }
      : own.assignee === 'both' ? { text: 'agents propose, you decide' } : { text: 'with the agents' }]
  }
  return out
}

// The document the project started from keeps its exact name; a project from the command line gets its folder's.
const editorSlug = (paper: Paper) => paper.config.editorDoc || paper.state.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
/** The editor's own document folder, the one `npm run dev` lists, so every paper's manuscript shows up there. */
const EDITOR_DOCUMENTS = resolve(process.env.GALLEY_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.galley-data'))
export const editorDir = (paper: Paper) => paper.config.editorDir || EDITOR_DOCUMENTS
// In the editor the title is #, sections are ##, and a section's own subheadings sit one level lower.
const demote = (text: string) => text.replace(/^(#{1,5}) /gm, '#$1 ')
const promote = (text: string) => text.replace(/^#(#{1,5}) /gm, '$1 ')

/** Writes a file even where a stale link stands in its place: a link whose target is gone gives way to the file. */
export function writeReplacing(path: string, text: string): void {
  try { if (lstatSync(path).isSymbolicLink() && !existsSync(path)) unlinkSync(path) } catch { /* nothing there yet */ }
  writeFileSync(path, text)
}

/** The editor shows the manuscript's source: what a person changes there is what the paper says. */
/** The editor's copy of the paper as it stands: the title from the start, sections once outlined, each section's text once someone has written it. */
function editorCopy(paper: Paper): { text: string, base: Record<string, string> } {
  const s = paper.state
  const title = paper.config.title || s.titleByHuman || s.frame?.title || s.plan?.workingTitle || 'Untitled paper'
  const base: Record<string, string> = { title, abstract: s.frame?.abstract ?? '' }
  const blocks = [`# ${title}`]
  if (s.frame) blocks.push(`## Abstract\n\n${base.abstract}`)
  for (const section of s.outline?.sections ?? []) {
    const passage = s.passages[section.id]?.text ?? ''
    base[section.id] = passage
    blocks.push(passage ? `## ${section.title}\n\n${demote(passage)}` : `## ${section.title}`)
  }
  return { text: blocks.join('\n\n') + '\n', base }
}

const fileText = (path: string): string | null => { try { return readFileSync(path, 'utf8') } catch { return null } }
const touchedWithin = (path: string, ms: number) => { try { return Date.now() - statSync(path).mtimeMs < ms } catch { return false } }
const digest = (text: string | null) => (text === null ? '' : createHash('sha256').update(text).digest('hex'))

/**
 * Write the editor's copy and its notes. `seen` is what the files held when
 * galley last read them: if a person saved since, that file is left alone
 * now, and the next pass takes their change in first.
 */
function writeEditorDocument(paper: Paper, seen?: { doc: string | null, notes: string | null }): void {
  const s = paper.state
  const dir = editorDir(paper)
  mkdirSync(dir, { recursive: true })
  const docPath = join(dir, `${editorSlug(paper)}.md`)
  const notesPath = join(dir, `${editorSlug(paper)}.annotations.json`)
  const { text, base } = editorCopy(paper)
  const docOnDisk = fileText(docPath)
  if (seen && docOnDisk !== seen.doc) return
  if (docOnDisk !== text) writeReplacing(docPath, text)
  s.editorBase = base
  const notesOnDisk = fileText(notesPath)
  let notes = notesOnDisk
  if (!seen || notesOnDisk === seen.notes) {
    const existing: Annotation[] = notesOnDisk ? (JSON.parse(notesOnDisk).annotations ?? []) : []
    const placed = new Map(existing.map((a) => [a.id, a]))
    const lines = text.split('\n')
    const human = existing.filter((a) => !a.id.startsWith('galley-')).map((a) => withAnswers(paper, a))
    const heading = (sectionId: string | null | undefined) => s.outline?.sections.find((sec) => sec.id === sectionId)?.title ?? base.title
    const ours = s.findings
      .filter((f) => f.origin === 'agent' && !f.parent && (f.severity !== 'minor' || f.status === 'noted' || leftForAuthors(f)))
      .map((f) => findingThread(paper, f, lines, heading(f.sectionId), placed.get(`galley-${f.id}`)))
    // The caution the agents keep out of the paper, beside the words it concerns.
    const cautions = (s.authorNotes ?? []).map((n) => authorNoteThread(paper, n, lines, heading(n.sectionId), placed.get(`galley-note-${n.id}`)))
    notes = JSON.stringify({ annotations: [...human, ...ours, ...cautions] }, null, 2)
    if (notes !== notesOnDisk) writeReplacing(notesPath, notes)
    s.editorResolved = ours.filter((a) => a.resolved).map((a) => a.id)
  }
  s.editorWritten = { doc: digest(text), notes: digest(notes) }
  paper.save()
  const proposalsPath = join(dir, `${editorSlug(paper)}.proposals.json`)
  const proposals = JSON.stringify({ proposals: (s.proposals ?? []).filter((p) => p.state === 'pending') }, null, 2)
  if (fileText(proposalsPath) !== proposals) writeReplacing(proposalsPath, proposals)
}

// A note half typed is not yet a note: galley reads a person's changes once they pause.
const PAUSE_MS = 4_000

/**
 * Keep the editor's copy in step with the paper, while it is being written:
 * take in what a person changed there (edits, notes, replies, decisions on
 * proposed changes), then write what the paper now says.
 */
export function syncEditor(paper: Paper): { edits: string[], notes: number, decisions: number } {
  const s = paper.state
  const dir = editorDir(paper)
  const docPath = join(dir, `${editorSlug(paper)}.md`)
  const notesPath = join(dir, `${editorSlug(paper)}.annotations.json`)
  // On the first pass the document still holds the seed: its notes and proposals belong to the seed, so they move
  // into the project with it, and the paper's first write carries only its own threads.
  if (!s.editorWritten) {
    for (const [file, kept] of [[notesPath, 'seed.annotations.json'], [join(dir, `${editorSlug(paper)}.proposals.json`), 'seed.proposals.json']] as const) {
      const held = fileText(file)
      if (held === null) continue
      writeFileSync(paper.path(kept), held)
      rmSync(file, { force: true })
    }
  }
  const seen = { doc: fileText(docPath), notes: fileText(notesPath) }
  const docChanged = seen.doc !== null && digest(seen.doc) !== s.editorWritten?.doc
  const notesChanged = seen.notes !== null && digest(seen.notes) !== s.editorWritten?.notes
  if ((docChanged && touchedWithin(docPath, PAUSE_MS)) || (notesChanged && touchedWithin(notesPath, PAUSE_MS))) return { edits: [], notes: 0, decisions: 0 }
  const decisions = importProposalDecisions(paper)
  const edits = docChanged ? importEditorEdits(paper, seen.doc!) : []
  const notes = seen.notes !== null ? importHumanNotes(paper, seen.notes) : 0
  writeEditorDocument(paper, seen)
  return { edits, notes, decisions }
}

/** Accept and Decline from the editor: an accepted change is already in the text; a declined one is closed. */
export function importProposalDecisions(paper: Paper): number {
  const s = paper.state
  const path = join(editorDir(paper), `${editorSlug(paper)}.proposals.json`)
  if (!existsSync(path) || !s.proposals?.length) return 0
  const decided = (JSON.parse(readFileSync(path, 'utf8')).proposals ?? []) as { id: string; state: string }[]
  let n = 0
  for (const d of decided) {
    const p = s.proposals.find((x) => x.id === d.id)
    if (!p || p.state !== 'pending' || (d.state !== 'accepted' && d.state !== 'declined')) continue
    p.state = d.state
    n++
    const f = s.findings.find((x) => x.id === p.findingId)
    if (!f) continue
    const pending = s.proposals.filter((x) => x.findingId === f.id && x.state === 'pending')
    if (pending.length) continue
    const accepted = s.proposals.filter((x) => x.findingId === f.id && x.state === 'accepted')
    if (accepted.length) {
      f.dispositions.at(-1)?.edits.push(...accepted.map((x) => ({ old: x.old, new: x.new })))
      f.status = 'fixed'
      f.assignee = 'agents'
    } else {
      // Declining every change proposed for a finding is the person's decision: it is theirs, and settled.
      f.status = 'noted'
      f.assignee = 'humans'
      paper.note('proposals', `You declined the changes proposed for ${f.id} (${f.question}).`)
    }
  }
  if (n) paper.save()
  return n
}

/** Text a person changed in the editor since galley last wrote it becomes their revision of the paper. */
export function importEditorEdits(paper: Paper, text?: string): string[] {
  const s = paper.state
  if (text === undefined) {
    const path = join(editorDir(paper), `${editorSlug(paper)}.md`)
    if (!existsSync(path)) return []
    text = readFileSync(path, 'utf8')
  }
  if (!s.editorBase) return []
  const author = paper.config.authors[0]?.name ?? 'the author'
  const changed: string[] = []
  const titleLine = text.match(/^# (.+)$/m)?.[1]?.trim()
  if (titleLine && titleLine !== s.editorBase.title) {
    s.titleByHuman = titleLine
    if (s.frame) s.frame.title = titleLine
    changed.push('title')
  }
  const blocks = text.split(/^## /m).slice(1).map((block) => {
    const newline = block.indexOf('\n')
    return newline < 0 ? { heading: block.trim(), body: '' } : { heading: block.slice(0, newline).trim(), body: block.slice(newline + 1).trim() }
  })
  const abstract = blocks.find((b) => b.heading === 'Abstract')
  if (abstract && s.frame && abstract.body !== s.editorBase.abstract.trim()) { s.frame.abstract = abstract.body; changed.push('abstract') }
  const rest = blocks.filter((b) => b !== abstract)
  s.outline?.sections.forEach((section, i) => {
    const block = rest.find((b) => b.heading === section.title) ?? rest[i]
    if (!block) return
    const body = promote(block.body)
    if (body === (s.editorBase![section.id] ?? '').trim()) return
    if (s.passages[section.id]) setPassageText(paper, section.id, body, author)
    else if (body) {
      // A section a person writes before the Author reaches it is theirs: the Author drafts only sections no one has written.
      s.passages[section.id] = { sectionId: section.id, text: body, revisions: [{ at: new Date().toISOString(), text: body, by: { kind: 'human', name: author }, reason: 'written in the editor' }], checked: 'unchecked' }
    } else return
    changed.push(section.id)
  })
  if (changed.length) {
    paper.journal({ event: 'human_edits', sections: changed })
    paper.save()
  }
  return changed
}

function setPassageText(paper: Paper, sectionId: string, text: string, name: string): void {
  const passage = paper.state.passages[sectionId]
  if (!passage || passage.text === text) return
  passage.text = text
  passage.revisions.push({ at: new Date().toISOString(), text, by: { kind: 'human', name }, reason: 'edited in the editor' })
}

/** Notes a person wrote in the editor become threads; the agents answer them on the next run. */
export function importHumanNotes(paper: Paper, json?: string): number {
  const s = paper.state
  if (json === undefined) {
    const path = join(editorDir(paper), `${editorSlug(paper)}.annotations.json`)
    if (!existsSync(path)) return 0
    json = readFileSync(path, 'utf8')
  }
  const annotations: Annotation[] = JSON.parse(json).annotations ?? []
  const seen = new Set(s.repliesSeen ?? [])
  const assigned = (text: string) => /@(humans?|me)\b/i.test(text) ? 'humans' as const : /@both\b/i.test(text) ? 'both' as const : 'agents' as const
  const untagged = (text: string) => text.replace(/@(humans?|me|both|agents)\b/gi, '').trim()
  const sectionOf = (snippet: string) => s.outline?.sections.find((sec) => squash(s.passages[sec.id]?.text ?? '').includes(squash(snippet).slice(0, 60)))?.id ?? null
  let added = 0
  for (const a of annotations) {
    // A person's own note, once they have stopped typing it.
    if (!a.id.startsWith('galley-') && !s.findings.some((f) => f.id === `H-${a.id}`)) {
      const comment = a.comment.trim()
      if (comment && Date.now() - Date.parse(a.updated_at) > NOTE_SETTLE_MS) {
        s.findings.push({
          id: `H-${a.id}`, at: a.created_at, round: s.round, seat: 'human', family: paper.config.seats.challenger, model: 'human',
          severity: 'material', sectionId: sectionOf(a.snippet), quote: a.snippet, question: untagged(comment),
          alternatives: '', evidence: '', decision: comment, edit: null, status: 'open', assignee: assigned(comment), origin: 'human', dispositions: [],
        })
        added++
      }
    }
    // An answer a person gave in a thread, theirs or an agent's: the agents take it up there.
    for (const r of a.replies ?? []) {
      if (r.author.kind !== 'human' || seen.has(r.id)) continue
      seen.add(r.id)
      const parentId = a.id.startsWith('galley-') ? a.id.slice('galley-'.length) : `H-${a.id}`
      const parent = s.findings.find((f) => f.id === parentId)
      s.findings.push({
        id: `H-${r.id}`, parent: parentId, at: r.created_at, round: s.round, seat: 'human', family: paper.config.seats.challenger, model: 'human',
        severity: 'material', sectionId: parent?.sectionId ?? sectionOf(a.snippet), quote: a.snippet,
        question: parent ? `On ${parentId} (${parent.question}): ${untagged(r.text)}` : untagged(r.text),
        alternatives: '', evidence: '', decision: r.text, edit: null, status: 'open', assignee: assigned(r.text), origin: 'human', dispositions: [],
      })
      added++
    }
    // A thread a person resolved is settled: the agents stop working on it. galley marks a thread resolved itself
    // once its finding is answered; that mark is not a person's decision, and a referee who rejects the answer
    // reopens the finding for the agents.
    if (a.resolved && a.id.startsWith('galley-') && s.editorResolved && !s.editorResolved.includes(a.id)) {
      const f = s.findings.find((x) => x.id === a.id.slice('galley-'.length))
      if (f && f.status === 'open') {
        f.status = 'noted'
        f.assignee = 'humans'
        paper.note('editor', `You resolved ${f.id} in the editor: ${f.question}`)
        added++
      }
    }
  }
  s.repliesSeen = [...seen]
  if (added) paper.save()
  return added
}

// How long a note must sit unchanged before galley takes it as written.
const NOTE_SETTLE_MS = 15_000

/** How the referee findings were settled, every material one accounted for. */
function findingsSummary(record: Record_, authors = 'the authors'): string {
  const parts = ([
    ['run.findings_fixed', 'fixed'], ['run.findings_rebutted', 'rebutted'], ['run.findings_limitation', `left for ${authors}`],
    ['run.findings_decided', 'decided by a third model family'], ['run.findings_set_aside', 'set aside by a third model family, with the text answering each'],
    ['run.findings_fallback', `left for ${authors} when adjudication could not settle them`], ['run.findings_yours', `set aside by ${authors}`], ['run.findings_open', 'still open'],
  ] as const).filter(([key]) => Number(record[key]) > 0).map(([key, what]) => `${record[key]} ${what}`)
  return `${record['run.findings']} over ${record['run.rounds']} round${Number(record['run.rounds']) === 1 ? '' : 's'}; ${record['run.findings_material']} material or critical${parts.length ? `: ${parts.join(', ')}` : ''}`
}

// ---------------------------------------------------------------- sign-off

function signoff(paper: Paper, record: Record_): string {
  const s = paper.state
  const title = paper.config.title || s.frame?.title || s.plan?.workingTitle || 'Untitled'
  const active = s.claims.filter((c) => c.status !== 'dropped')
  const list = (items: string[], empty: string) => items.length ? items.map((x) => `- ${x}`).join('\n') : `- ${empty}`
  const decl = paper.config.declarations ?? {}
  const declare = [
    !paper.config.authors.length ? 'Authors: none set. Add them to paper.json ("authors": [{"name", "affiliation", "email"}]).' : '',
    !paper.config.authors.some((a) => a.affiliation) ? 'Affiliations: none set.' : '',
    !decl.competing_interests ? 'Competing interests: to declare (paper.json "declarations.competing_interests").' : '',
    !decl.funding ? 'Funding: to declare ("declarations.funding").' : '',
    'Use of AI: confirm the statement in the manuscript describes your process, and check your venue\'s policy on AI-assisted manuscripts.',
  ].filter(Boolean)
  return `# Sign-off: ${title}

Outcome: **${s.outcome ?? 'in progress'}**. ${s.outcome === 'ready_for_submission' ? 'Every step the system can take is done. What follows is yours.' : ''}

## Declarations only you can make
${list(declare, 'All declared.')}

${s.unreferenced?.length ? `## Works the text names that no source was found for (${s.unreferenced.length}). Add the reference, or drop the name
${list(s.unreferenced.map((u) => `${u.sectionId}: "${u.quote}"`), 'None.')}

` : ''}## Claims the system added (${active.filter((c) => c.origin === 'system').length}). Stand behind each, or cut it
${list(active.filter((c) => c.origin === 'system').map((c) => `${c.id} [${c.status}] ${c.text}`), 'None.')}

## Claims without a verified source (${active.filter((c) => c.status === 'unsupported').length}). The text states each plainly, and a comment beside it says so: cite a source, or cut it
${list(active.filter((c) => c.status === 'unsupported').map((c) => `${c.id}: ${c.text}`), 'None.')}

## Comments the agents left for you beside the text (${(s.authorNotes ?? []).length + s.findings.filter((f) => f.status === 'limitation' || (f.status === 'adjudicated' && f.adjudication?.decision.startsWith('limitation'))).length}). The paper states none of them
${list([
    ...(s.authorNotes ?? []).map((n) => `${n.sectionId ?? 'paper'} [${NOTE_KIND[n.kind]}]${n.quote ? ` on "${n.quote.slice(0, 80)}"` : ''}: ${n.text}`),
    ...s.findings.filter((f) => f.status === 'limitation' || (f.status === 'adjudicated' && f.adjudication?.decision.startsWith('limitation'))).map((f) => `${f.sectionId ?? 'paper'} [limitation, ${f.id}]: ${f.question}`),
  ], 'None.')}

## Claims narrowed to what their evidence supports (${active.filter((c) => c.status === 'narrowed').length})
${list(active.filter((c) => c.status === 'narrowed').map((c) => `${c.id}: ${c.text}`), 'None.')}

## Decisions made by a third model family, and notes left for you
${list(s.notes.filter((n) => n.forHuman).map((n) => n.text), 'None.')}

## Findings a third model family set aside (${s.findings.filter((f) => f.adjudication?.setAside).length}). Check that each reason holds
${list(s.findings.filter((f) => f.adjudication?.setAside).map((f) => `${f.id}: ${f.question} Reason: ${f.adjudication!.decision.replace(/^set_aside: /, '')} ${f.adjudication!.handledBy ? `Answered by: "${f.adjudication!.handledBy}"` : `Answered by the edits: ${f.adjudication!.edits.map((e) => `"${e.new}"`).join('; ')}`}`), 'None.')}

## Findings stated as limitations because adjudication could not settle them (${s.findings.filter((f) => f.adjudication?.fallback).length})
${list(s.findings.filter((f) => f.adjudication?.fallback).map((f) => `${f.id}: ${f.question} The paper now says: "${f.adjudication!.edits[0]?.new ?? ''}"`), 'None.')}

## Typeset review
${s.proof ? `Read ${s.proof.rounds === 1 ? 'once' : `${s.proof.rounds} times`} as a reader sees it; ${s.proof.fixed} defect${s.proof.fixed === 1 ? '' : 's'} sent back and fixed. ${s.proof.left.length ? `Still to fix before submission (${s.proof.left.length}):` : 'The last reading found nothing left to fix.'}` : 'Not run.'}
${s.proof?.left.length ? list(s.proof.left.map((d) => `page ${d.page ?? '?'}, ${d.where}: "${d.quote}". ${d.problem} Fix: ${d.fix}`), 'None.') : ''}

## Threads assigned to people
${list(s.findings.filter((f) => f.assignee === 'humans' && f.status === 'open').map((f) => `${f.id}: ${f.question}`), 'None.')}

## Steps skipped along the way
${list(s.notes.filter((n) => / was skipped /.test(n.text)).map((n) => `${n.behavior}: ${n.text}`), 'None.')}

${s.literature?.status === 'done' ? `## The systematic review
Question: ${s.literature.question}
Canary run ${s.literature.key}, searched ${s.literature.searchedOn}: ${s.literature.counts?.discovered} records identified, ${s.literature.counts?.screened} screened, ${s.literature.counts?.reviewed} read in full; ${s.literature.counts?.findings} findings, cited from ${s.literature.counts?.cited} publications. The full research bundle is ${s.literature.bundle}. Check that the question is the one you want answered; the findings appear in the claim ledger as "from the systematic review".

` : ''}${runsOf(paper).length ? `## Simulations: check what each one assumes
${runsOf(paper).map((r) => `${r.id} ${r.title} (${methodWords(r.result.method)}, ${sizeOf(r.result)}, seed ${r.result.provenance.seed}${r.result.provenance.ok ? '' : `; checks: ${r.result.provenance.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`})\n${r.result.spec.inputs.map((i) => `- ${i.name} ~ ${i.dist}: ${r.assumptions.find((a) => a.name === i.name)?.basis ?? 'no basis given'}`).join('\n')}`).join('\n\n')}

` : ''}${s.analysis?.plan.length ? `## The analysis of your data: check it is the one your field expects
Field: ${s.analysis.field || 'not named'}. ${s.analysis.mode === 'code' ? `The analyses ran as code in a sandbox on ${Object.entries(s.analysis.environment ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}; each script is in analysis/.` : 'The analyses ran as galley\'s built-in operations.'} ${s.analysis.reviewed ? `The plan was reviewed by a statistician (${FAMILY_NAMES[s.analysis.reviewed.family]}): ${s.analysis.reviewed.notes.join(' ')}` : 'The plan was not reviewed.'}
${s.analysis.extracts?.length ? `Extracts taken from the database (each query is in the evidence package, analysis.json):\n${list(s.analysis.extracts.map((e) => `${e.id} ${e.purpose}: ${e.ok ? `${e.rows} rows` : `not taken: ${e.error}`}`), '')}\n` : ''}${s.analysis.prepare?.report ? `The shared preparation, as it ran:\n${list(s.analysis.prepare.report.steps.map((st) => `${st.step}${st.rows_before !== undefined && st.rows_after !== undefined ? ` (${st.rows_before} rows to ${st.rows_after})` : ''}: ${st.note}`), 'No steps reported.')}\n` : ''}${list(Object.entries(s.analysis.runs ?? {}).flatMap(([id, r]) => r.checks.filter((c) => !c.holds).map((c) => `${id}: the assumption "${c.assumption}" does not hold (${c.method}). ${c.note}`)), 'Every assumption check held.')}
${s.analysis.notComputed?.length ? `Planned but not computed, so the paper does not describe them:\n${list(s.analysis.notComputed.map((n) => `${n.id} ${n.question}: ${n.why.split('\n').at(-1)}`), '')}` : ''}

` : ''}## Your datasets: check where each one comes from
${list((paper.config.datasets ?? []).map((u) => `${u.id} "${u.name}"${u.version ? `, version ${u.version}` : ''}: ${u.producedBy === 'others' ? 'produced by others' : 'produced by you'}${u.doi ? `, DOI ${u.doi}` : u.url ? `, at ${u.url}` : ', not published'}${u.describedIn ? `, first reported in ${u.describedIn}` : ''}${u.licence ? `, licence ${u.licence}` : ''}; ${u.private ? 'private' : 'shared'}; files ${u.materials.join(', ')}`), 'None given as datasets.')}

## Your materials
${list((paper.config.materials ?? []).map((m) => `${m.id} ${m.kind} ${m.url ?? m.name}${m.kind === 'dataset' ? (m.private ? ': private, the models saw only its profile and the measurements' : ': shared, the models saw its profile and first rows') : ''}`), 'None.')}
${paper.config.worldModel ? `
## The world model the sources come from: check it is the version you meant
- "${paper.config.worldModel.name}": ${paper.config.worldModel.claims.toLocaleString('en-US')} claims, ${paper.config.worldModel.evidence.toLocaleString('en-US')} evidence records, ${paper.config.worldModel.sources.toLocaleString('en-US')} sources with an excerpt; SHA-256 ${paper.config.worldModel.sha256}
- ${paper.config.worldModel.only ? 'The paper\'s only sources: no other literature was searched, and there was no systematic review or web search.' : 'Searched first; the literature and the web were searched as well.'}
- Cited from it: ${new Set(s.citations.filter((c) => c.status === 'verified' && worldModelOf(paper)?.publications.has(c.workId)).map((c) => c.workId)).size} sources
` : ''}
${Object.values(s.measurements ?? {}).length ? `\nMeasurements galley computed from your data (check each against your own analysis):\n${Object.values(s.measurements ?? {}).map((m) => `- ${m.id}: ${m.summary}`).join('\n')}\n` : ''}

## Production record
${Object.entries(record).map(([k, v]) => `- ${PLACEHOLDERS[k] ?? LIT_PLACEHOLDERS[k] ?? k}: ${v}`).join('\n')}
`
}

/** The sign-off sheet, written again when something after typesetting changes what it says (the typeset review). */
export function writeSignoff(paper: Paper): void {
  const out = paper.path('out')
  if (!existsSync(out)) return
  writeFileSync(join(out, 'signoff.md'), signoff(paper, productionRecord(paper)))
}

// ---------------------------------------------------------------- evidence package

const uuidish = (text: string) => {
  const h = createHash('sha256').update(text).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

const yaml = (record: Record<string, unknown>) => Object.entries(record).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n'

function claimClass(c: Claim): string {
  if (c.status === 'internal') return 'derived_inference'
  if (c.status === 'assumed') return 'assumption'
  if (c.status === 'unsupported' || c.status === 'open') return 'hypothesis'
  return 'observed_fact'
}

function exportEvidence(paper: Paper): void {
  const s = paper.state
  const root = paper.path('out', 'evidence')
  rmSync(root, { recursive: true, force: true })
  for (const d of ['claims', 'evidence', 'sources']) mkdirSync(join(root, d), { recursive: true })
  for (const c of s.claims.filter((x) => x.status !== 'dropped')) {
    const cid = `C-${uuidish(`${s.slug}:${c.id}`)}`
    const evidenceIds: string[] = []
    const cites = s.citations.filter((k) => k.claimId === c.id && k.status === 'verified')
    for (const cite of cites) {
      const work = s.works[cite.workId]
      const sid = `S-${uuidish(`${s.slug}:${cite.workId}:${cite.passage}`)}`
      const eid = `E-${uuidish(`${s.slug}:${cite.id}`)}`
      writeFileSync(join(root, 'sources', `${sid}.yaml`), yaml({ id: sid, kind: 'publication', title: work.title, uri: work.doi ? `https://doi.org/${work.doi}` : work.url, date: work.year ? String(work.year) : null, locator: 'abstract', excerpt: cite.passage, access: 'inspected' }))
      writeFileSync(join(root, 'evidence', `${eid}.yaml`), yaml({ id: eid, kind: 'external', summary: `${cite.verdict?.outcome ?? 'supported'}: ${cite.verdict?.reason ?? ''}`.trim(), source_ids: [sid], independent: false, limitations: ['Verified against the abstract; the full text was not inspected.'], premise_claim_ids: [], claim_ids: [cid] }))
      evidenceIds.push(eid)
    }
    if (!cites.length) {
      const sid = `S-${uuidish(`${s.slug}:seed:${c.id}`)}`
      const eid = `E-${uuidish(`${s.slug}:own:${c.id}`)}`
      const kind = c.status === 'assumed' || c.status === 'unsupported' ? 'assumption' : 'statement'
      writeFileSync(join(root, 'sources', `${sid}.yaml`), yaml({ id: sid, kind: c.origin === 'seed' ? 'conversation' : 'reasoning', title: c.origin === 'seed' ? 'Seed text supplied by the author' : 'Argument plan of the manuscript', uri: null, date: s.createdAt.slice(0, 10), locator: c.id, excerpt: c.seedQuote || c.text, access: 'inspected' }))
      writeFileSync(join(root, 'evidence', `${eid}.yaml`), yaml({ id: eid, kind, summary: c.status === 'internal' ? 'Stated by the authors about their own work, as presented in the manuscript.' : c.status === 'unsupported' ? 'No external evidence was verified; the manuscript states this as a hypothesis.' : 'Common knowledge or a stated premise.', source_ids: [sid], independent: false, limitations: [], premise_claim_ids: [], claim_ids: [cid] }))
      evidenceIds.push(eid)
    }
    // A review finding keeps Canary's class, made conservative as Canary does for Resolvent: low and moderate become medium.
    const uncertainty = c.origin === 'review' ? (c.uncertainty === 'high' ? 'high' : 'medium') : c.status === 'supported' && cites.length >= 2 ? 'low' : c.status === 'supported' || c.status === 'narrowed' || c.status === 'internal' ? 'medium' : 'high'
    writeFileSync(join(root, 'claims', `${cid}.yaml`), yaml({ id: cid, class: claimClass(c), statement: c.text, uncertainty, evidence_ids: evidenceIds, state: 'active' }))
  }
  // Each simulation's specification and results: with the seed, anyone can rerun it and get the same numbers.
  for (const r of runsOf(paper)) {
    mkdirSync(join(root, 'simulations'), { recursive: true })
    writeFileSync(join(root, 'simulations', `${r.id}.json`), JSON.stringify({ id: r.id, title: r.title, purpose: r.purpose, assumptions: r.assumptions, spec: r.result.spec, provenance: r.result.provenance, outputs: r.result.outputs, events: r.result.events, numbers: r.result.numbers, series: r.result.series }, null, 2))
  }
  // The systematic review's protocol and counts, beside Canary's own bundle in the paper folder.
  if (s.literature?.status === 'done') writeFileSync(join(root, 'literature-review.json'), JSON.stringify({ question: s.literature.question, canary_run: s.literature.key, searched: s.literature.searchedOn, models: s.literature.models, protocol: s.literature.protocol, counts: s.literature.counts, disagreements: s.literature.contradictions, open_questions: s.literature.gaps, findings: s.literature.claimIds }, null, 2))
  // Measurements carry their exact specification, so anyone holding the data can recompute every number.
  const measurements = Object.values(s.measurements ?? {})
  if (measurements.length) writeFileSync(join(root, 'measurements.json'), JSON.stringify(measurements.map((m) => m.spec
    ? { id: m.id, dataset: (paper.config.materials ?? []).find((x) => x.id === m.spec!.dataset)?.name ?? m.spec.dataset, spec: m.spec, result: m.summary, n: m.n }
    : { id: m.id, analysis: m.analysis, name: m.name, value: m.value, ci: m.ci ?? null, n: m.n, result: m.summary, code: `analysis/${m.analysis}/analysis.py` }), null, 2) + '\n')
  // The analysis as planned, reviewed and run: the field's conventions, the preparation, each analysis with its checks, and what did not run.
  const a = s.analysis
  if (a?.plan.length) writeFileSync(join(root, 'analysis.json'), JSON.stringify({ field: a.field, conventions: a.conventions, preparation: a.preparation, mode: a.mode, reviewed_by: a.reviewed?.family ?? null, review_notes: a.reviewed?.notes ?? [], environment: a.environment ?? null, preparation_report: a.prepare?.report ?? null, extracts: (a.extracts ?? []).map((e) => ({ id: e.id, database: (paper.config.datasets ?? []).find((u) => u.id === e.database)?.name ?? e.database, purpose: e.purpose, sql: e.sql, ran: e.ok, rows: e.rows ?? null, sha256: e.sha256 ?? null, error: e.error ?? null })), analyses: a.plan.map((p) => ({ ...p, ran: a.runs?.[p.id]?.ok ?? false, results: a.runs?.[p.id]?.results ?? [], checks: a.runs?.[p.id]?.checks ?? [] })), not_computed: a.notComputed ?? [] }, null, 2) + '\n')
  writeFileSync(join(root, 'README.md'), `# Evidence package\n\nThe claims of this manuscript, the evidence each rests on, and the verbatim passages of its sources, as Resolvent records (claims/, evidence/, sources/). Copy them into a Resolvent world model to admit them there.${measurements.length ? '\n\nmeasurements.json holds every number the manuscript states about the authors\' data, with the analysis that produced it; analysis.json holds the analysis plan, its review, and each analysis\'s results and assumption checks.' : ''}\n`)
}

/** The analyses as runnable code: each analysis's script, with what it needs and how to run it on the data. */
function writeAnalysisPackage(paper: Paper, dir: string): void {
  const a = paper.state.analysis
  if (a?.mode !== 'code' || !a.runs) return
  mkdirSync(dir, { recursive: true })
  for (const [id, run] of Object.entries(a.runs)) {
    if (!run.ok) continue
    mkdirSync(join(dir, id), { recursive: true })
    copyFileSync(paper.path('analysis', id, 'analysis.py'), join(dir, id, 'analysis.py'))
  }
  // The shared preparation on its own: run it to see each step with the rows it kept (every analysis.py holds it too).
  if (a.prepare?.ok && existsSync(paper.path('analysis', 'preparation', 'prepare.py'))) {
    mkdirSync(join(dir, 'preparation'), { recursive: true })
    copyFileSync(paper.path('analysis', 'preparation', 'prepare.py'), join(dir, 'preparation', 'prepare.py'))
  }
  const datasets = (paper.config.materials ?? []).filter((m) => m.kind === 'dataset')
  writeFileSync(join(dir, 'README.md'), `# The analyses\n\nEach folder holds one analysis of the paper's data as it ran, for galley, in a sandbox with no network. To run one, write a data.json that maps each dataset id to the CSV file holding it, then run \`python analysis.py data.json\`; it prints the results and the assumption checks as JSON.\n\nDatasets:\n${datasets.map((d) => `- ${d.id}: ${d.name}`).join('\n')}\n\nIt ran on ${Object.entries(a.environment ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'Python with numpy, scipy, pandas and statsmodels'}.\n`)
}

// ---------------------------------------------------------------- typeset

export function contentHash(paper: Paper): string {
  const s = paper.state
  return createHash('sha256').update(JSON.stringify({
    passages: Object.values(s.passages).map((p) => p.text), frame: s.frame, outcome: s.outcome,
    // The claim ledger is printed as an appendix, so a restated claim is a new revision too.
    claims: s.claims.map((c) => [c.id, c.status, c.text]),
    findings: s.findings.map((f) => [f.id, f.status, f.dispositions.length]), citations: s.citations.map((c) => [c.id, c.status]),
    // A figure drawn again is a new revision, though its status is the same as before.
    figures: s.figures.map((f) => [f.id, f.status, f.source ?? null, f.caption]), title: paper.config.title, authors: paper.config.authors, decl: paper.config.declarations,
  })).digest('hex').slice(0, 16)
}

export async function typeset(paper: Paper): Promise<string[]> {
  const build = paper.path('build')
  const out = paper.path('out')
  mkdirSync(build, { recursive: true })
  mkdirSync(out, { recursive: true })
  // The review's flow figure is drawn from its counts by the system before the manuscript is built around it.
  const flowSource = paper.state.literature?.status === 'done' ? reviewFlowTypst(paper.state.literature) : null
  if (flowSource) {
    const figures = join(build, 'figures')
    mkdirSync(figures, { recursive: true })
    writeFileSync(join(figures, 'review-flow.typ'), flowSource)
    try { await exec('typst', ['compile', 'review-flow.typ', 'review-flow.png', '--ppi', '250'], figures) } catch (error) { paper.note('typeset', `The systematic review's flow figure was not drawn: ${(error as Error).message.slice(0, 200)}`) }
  }
  const { markdown, refs, record } = await buildManuscript(paper)
  writeFileSync(join(build, 'manuscript.md'), markdown)
  writeFileSync(join(build, 'refs.json'), JSON.stringify(refs, null, 2))
  const common = ['manuscript.md', '--citeproc', '--bibliography', 'refs.json', '--resource-path', build]
  // Typst is written with pandoc's smart quotes off, so the quotes stay as printedQuotes wrote them.
  const typstOut = ['-t', 'typst-smart']
  const made: string[] = []
  await exec('pandoc', [...common, ...typstOut, '-o', join(out, 'paper.pdf'), '--pdf-engine=typst', '-V', 'papersize=a4', '-V', 'fontsize=10.5pt', '-V', 'section-numbering=1.1', '-V', `header-includes=${TYPST_HEADER}`], build)
  made.push('paper.pdf')
  // The version many journals ask for at submission: line-numbered, with room between lines.
  try {
    await exec('pandoc', [...common, ...typstOut, '-o', join(out, 'paper-review.pdf'), '--pdf-engine=typst', '-V', 'papersize=a4', '-V', 'fontsize=11pt', '-V', 'section-numbering=1.1',
      '-V', `header-includes=${TYPST_HEADER}\n#set par.line(numbering: "1", numbering-scope: "page")\n#set par(leading: 1.1em)`], build)
    made.push('paper-review.pdf')
  } catch (error) {
    paper.note('typeset', `paper-review.pdf was not produced: ${(error as Error).message.slice(0, 200)}`)
  }
  for (const [format, file] of [['latex', 'paper.tex'], ['docx', 'paper.docx'], ['typst-smart', 'paper.typ']] as const) {
    try {
      await exec('pandoc', [...common, '-s', '-t', format, '-o', join(out, file)], build)
      made.push(file)
    } catch (error) {
      paper.note('typeset', `${file} was not produced: ${(error as Error).message.slice(0, 200)}`)
    }
  }
  try { await exec('pandoc', ['refs.json', '-f', 'csljson', '-t', 'biblatex', '-s', '-o', join(out, 'refs.bib')], build); made.push('refs.bib') } catch { /* LaTeX users can still use the PDF */ }
  copyFileSync(join(build, 'manuscript.md'), join(out, 'manuscript.md'))
  if (existsSync(paper.path('journal.jsonl'))) copyFileSync(paper.path('journal.jsonl'), join(out, 'production-journal.jsonl'))
  copyFileSync(join(build, 'refs.json'), join(out, 'refs.json'))
  const figures = join(build, 'figures')
  if (existsSync(figures)) {
    mkdirSync(join(out, 'figures'), { recursive: true })
    for (const fig of paper.state.figures.filter((f) => f.status === 'rendered' && f.file)) copyFileSync(join(build, fig.file!), join(out, fig.file!))
    if (existsSync(join(build, REVIEW_FLOW))) copyFileSync(join(build, REVIEW_FLOW), join(out, REVIEW_FLOW))
  }
  exportEvidence(paper)
  // The analyses of the authors' data, as the code that ran them.
  try { writeAnalysisPackage(paper, join(out, 'analysis')) } catch (error) { paper.note('typeset', `The analysis package was not written: ${(error as Error).message.slice(0, 200)}`) }
  // The runnable reproduction of the paper's simulations: a reader reruns them and checks every simulated number with Node or a browser.
  if (runsOf(paper).length) {
    try { writeReproduction(join(out, 'simulation'), runsOf(paper), { title: paper.config.title || paper.state.frame?.title }) } catch (error) { paper.note('typeset', `The simulation reproduction package was not written: ${(error as Error).message.slice(0, 200)}`) }
  }
  writeFileSync(join(out, 'signoff.md'), signoff(paper, record))
  // The editor's copy is a convenience: a failure to write it is noted, never a reason the paper stops.
  try { syncEditor(paper) } catch (error) { paper.note('typeset', `The editor copy of the manuscript was not written: ${(error as Error).message.slice(0, 200)}`) }
  try {
    rmSync(join(out, 'submission.zip'), { force: true })
    await exec('zip', ['-qr', 'submission.zip', ...made, 'manuscript.md', 'refs.json', 'evidence', 'production-journal.jsonl', ...(existsSync(join(out, 'figures')) ? ['figures'] : []), ...(existsSync(join(out, 'analysis')) ? ['analysis'] : []), ...(existsSync(join(out, 'simulation')) ? ['simulation'] : [])], out)
    made.push('submission.zip')
  } catch { /* the folder itself is the package */ }
  return made
}

export { claim }

export { fillPlaceholders, productionRecord }
