// Rendering: the state becomes a Pandoc manuscript and, through Typst, a PDF,
// plus LaTeX, Word, the editor's document with its notes, the sign-off sheet,
// the production record and a Resolvent evidence package.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claim, keyFor, ledgerAppendix } from './behaviors/common.js'
import { FAMILY_NAMES } from './config.js'
import { cleanCsl, cslForDoi, cslFromWork } from './evidence.js'
import type { Paper } from './paper.js'
import { LIT_PLACEHOLDERS, modelName } from './literature.js'
import { methodWords, runsOf, sizeOf } from './simulations.js'
import { writeReproduction } from './simulation/index.js'
import { PLACEHOLDERS } from './prompts.js'
import { fillPlaceholders, productionRecord, type Record_ } from './record.js'
import { software, sourceStatement } from './self.js'
import { escapeUnknownCitations, squash } from './text.js'
import type { Annotation } from '../types.js'
import type { Claim, Family, Finding } from './types.js'

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { cwd, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${stderr || error.message}`)) : resolve(stdout)))
}

// ---------------------------------------------------------------- references

async function references(paper: Paper): Promise<Record<string, unknown>[]> {
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []
  for (const cite of paper.state.citations.filter((c) => c.status === 'verified')) {
    const work = paper.state.works[cite.workId]
    const key = keyFor(paper, work)
    if (seen.has(key)) continue
    seen.add(key)
    if (!work.csl && work.doi) {
      const csl = await cslForDoi(work.doi)
      if (csl) work.csl = csl
    }
    const base = cleanCsl(work.csl ?? cslFromWork(work))
    out.push({ ...base, id: key })
  }
  paper.save()
  return out
}

// ---------------------------------------------------------------- manuscript

const yamlString = (text: string) => JSON.stringify(text)

function disclosure(paper: Paper, record: Record_): string {
  const seats = paper.config.seats
  const referees = [...new Set(paper.config.referees.map((r) => r.family))].map((f) => FAMILY_NAMES[f]).join(' and ')
  const lit = paper.state.literature?.status === 'done' ? paper.state.literature : null
  const everyCitation = lit ? 'every citation outside the systematic review' : 'every citation'
  const sims = runsOf(paper)
  const simulated = sims.length ? ` The Monte Carlo simulation${sims.length > 1 ? 's' : ''} (${sims.map((r) => `${r.id}, ${methodWords(r.result.method)} with ${sizeOf(r.result)}, seed ${r.result.provenance.seed}`).join('; ')}) ran on the authors' machine with galley's simulation engine, from a specification ${FAMILY_NAMES[seats.author]} wrote; every simulated number in the text is filled in from that run at the precision its Monte Carlo error supports, and the evidence package holds each specification with its results, so every number can be reproduced.` : ''
  const review = lit ? ` The systematic review ${paper.config.literatureReview === 'load-bearing' ? 'this paper reports' : 'reported in its own section'} was carried out with Canary: ${modelName(lit.models?.research)} planned the search of OpenAlex, screened the candidates, read the full texts and quoted the passages behind each finding, and ${modelName(lit.models?.audit)} audited every finding against those passages; the review's citations rest on them.` : ''
  return `This manuscript was produced with ${software()} from a seed text written by the author. ${FAMILY_NAMES[seats.author]} extracted the seed's claims, planned the argument, drafted every section and answered the referees. ${FAMILY_NAMES[seats.checker]} wrote the literature searches, selected candidate passages and checked each section against its claims. ${seats.challenger === seats.verifier ? `${FAMILY_NAMES[seats.challenger]} challenged the idea before drafting and verified ${everyCitation} against the passage it rests on.` : `${FAMILY_NAMES[seats.challenger]} challenged the idea before drafting, and ${FAMILY_NAMES[seats.verifier]} verified ${everyCitation} against the passage it rests on.`} Referee reports came from ${referees}, never from the family that drafted the text, and each answer to a material finding was verified by the referee family that raised it. Literature search ran through Canary over OpenAlex; bibliographic records come from the DOI registries.${review}${simulated} No model reviewed its own work. The production journal that accompanies this manuscript records every step, model call, verdict and decision with its time, and the evidence package holds each claim with the verbatim passage and verdict behind every citation.

| Production record | |
|---|---|
| Model calls | ${record['run.calls']} (Claude ${record['run.calls_claude']}, GPT ${record['run.calls_gpt']}, Gemini ${record['run.calls_gemini']}) |
| Tokens | ${record['run.tokens_in_m']} M in, ${record['run.tokens_out_k']} k out |
| Claims | ${record['run.claims']} (${record['run.claims_seed']} from the seed, ${record['run.claims_added']} added; ${record['run.claims_narrowed']} narrowed; ${record['run.claims_unsupported']} stated as hypotheses) |
| Works screened | ${record['run.works_screened']} |
| Citations | ${record['run.citations_verified']} verified, ${record['run.citations_rejected']} rejected |
${sims.length ? `| Simulations | ${sims.map((r) => `${r.id}: ${methodWords(r.result.method)}, ${sizeOf(r.result)}; ${r.result.provenance.ok ? 'every check passed' : `${r.result.provenance.checks.filter((c) => !c.ok).length} check(s) noted`}`).join('; ')} |\n` : ''}${lit ? `| Systematic review | ${record['lit.discovered']} records identified, ${record['lit.screened']} screened, ${record['lit.reviewed']} read in full and included; ${record['lit.findings']} findings, ${record['lit.audited']} audited |\n` : ''}| Referee findings | ${record['run.findings']} (${record['run.findings_material']} material or critical; ${record['run.findings_resolved']} resolved; ${record['run.findings_adjudicated']} adjudicated) over ${record['run.rounds']} round(s) |
| Verifier calibration | ${record['run.calibration'] === 'none to check' ? 'no verified citations to check' : `${record['run.calibration']} planted defective citations caught; ${record['run.calibration_controls']} unaltered controls accepted`} |
`
}

function declaration(value: string | undefined): string {
  return value && value.trim() ? value.trim() : 'To be declared by the author.'
}

export async function buildManuscript(paper: Paper): Promise<{ markdown: string; refs: Record<string, unknown>[]; record: Record_ }> {
  const s = paper.state
  const record = productionRecord(paper)
  const refs = await references(paper)
  // Escaped before quoting, so the backslash survives the YAML string.
  const known = new Set(refs.map((r) => String(r.id)))
  const plain = (text: string) => escapeUnknownCitations(text, known)
  const title = paper.config.title || s.frame?.title || s.plan?.workingTitle || 'Untitled'
  const authors = paper.config.authors.length ? paper.config.authors : [{ name: 'Author names to be confirmed' }]
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const head = [
    '---',
    `title: ${yamlString(plain(title))}`,
    'author:',
    ...authors.map((a) => `  - name: ${yamlString(a.name)}${a.affiliation ? `\n    affiliation: ${yamlString(a.affiliation)}` : ''}${a.email ? `\n    email: ${yamlString(a.email)}` : ''}`),
    `date: ${yamlString(date)}`,
    `abstract: ${yamlString(plain(fillPlaceholders(s.frame?.abstract ?? '', record).text))}`,
    `keywords: [${(s.frame?.keywords ?? []).map((k) => yamlString(plain(k))).join(', ')}]`,
    'link-citations: true',
    'reference-section-title: References',
    '---',
  ].join('\n')
  const body: string[] = []
  const unknown: string[] = []
  for (const section of s.outline?.sections ?? []) {
    const text = s.passages[section.id]?.text ?? ''
    const filled = fillPlaceholders(text, record)
    unknown.push(...filled.unknown)
    body.push(`# ${section.title}\n\n${filled.text}`)
    for (const fig of s.figures.filter((f) => f.sectionId === section.id && f.status === 'rendered' && f.file)) {
      body.push(`![${fig.caption.replace(/\n/g, ' ')}](${fig.file}){#fig-${fig.id} width=95%}`)
    }
  }
  const decl = paper.config.declarations ?? {}
  if (paper.config.ledgerAppendix !== false) body.push(`# Appendix A: Claim ledger {.unnumbered}\n\n${ledgerAppendix(paper)}`)
  body.push(`# Use of AI and production record {.unnumbered}\n\n${disclosure(paper, record)}`)
  const evidencePackage = 'Every claim in this manuscript, the evidence it rests on and the verbatim passages of its sources are available as an evidence package accompanying it (claims, evidence and sources in the Resolvent format).'
  const reproduction = runsOf(paper).length ? ` The simulations can be rerun, and every simulated number checked against this manuscript, with the reproduction package that accompanies it (simulation/: node simulate.mjs --verify, or index.html in a browser).` : ''
  body.push(`# Data and code availability {.unnumbered}\n\n${decl.availability || `${s.brief?.aboutSystem ? `${sourceStatement()} ` : ''}${evidencePackage}${reproduction}`}`)
  body.push(`# Competing interests {.unnumbered}\n\n${declaration(decl.competing_interests)}`)
  body.push(`# Funding {.unnumbered}\n\n${declaration(decl.funding)}`)
  body.push('# References {.unnumbered}\n\n::: {#refs}\n:::')
  if (unknown.length) paper.note('typeset', `Unknown placeholders left as "[not recorded]": ${[...new Set(unknown)].join(', ')}`)
  return { markdown: `${head}\n\n${escapeUnknownCitations(body.join('\n\n'), known)}\n`, refs, record }
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

function findingComment(paper: Paper, f: Finding): string {
  const model = f.origin === 'human' ? 'you' : `${FAMILY_NAMES[f.family]}`
  const last = f.dispositions.at(-1)
  const lines = [
    `${f.origin === 'human' ? 'Your note' : `${f.seat} referee, ${model}`} · ${f.severity} · ${f.status}`,
    f.question,
    f.decision ? `Asked: ${f.decision}` : '',
    last ? `Author (${FAMILY_NAMES[last.family]}), ${last.kind}: ${last.text}` : '',
    last?.verification ? `Referee: ${last.verification.outcome}. ${last.verification.reason}` : '',
    f.adjudication ? `Settled by ${FAMILY_NAMES[f.adjudication.family]}: ${f.adjudication.decision}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

const editorSlug = (paper: Paper) => paper.state.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
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
function writeEditorDocument(paper: Paper): void {
  const s = paper.state
  const dir = editorDir(paper)
  mkdirSync(dir, { recursive: true })
  const title = paper.config.title || s.frame?.title || 'Untitled'
  const base: Record<string, string> = { title, abstract: s.frame?.abstract ?? '' }
  const blocks = [`# ${title}`, `## Abstract\n\n${base.abstract}`]
  for (const section of s.outline?.sections ?? []) {
    const passage = s.passages[section.id]?.text ?? ''
    base[section.id] = passage
    blocks.push(`## ${section.title}\n\n${demote(passage)}`)
  }
  const text = blocks.join('\n\n') + '\n'
  writeReplacing(join(dir, `${editorSlug(paper)}.md`), text)
  s.editorBase = base
  paper.save()
  const lines = text.split('\n')
  const annotationsPath = join(dir, `${editorSlug(paper)}.annotations.json`)
  const existing: Annotation[] = existsSync(annotationsPath) ? (JSON.parse(readFileSync(annotationsPath, 'utf8')).annotations ?? []) : []
  const human = existing.filter((a) => !a.id.startsWith('galley-'))
  const at = new Date().toISOString()
  const ours: Annotation[] = s.findings
    .filter((f) => f.origin === 'agent' && (f.severity !== 'minor' || f.status === 'noted'))
    .map((f) => {
      const section = s.outline?.sections.find((sec) => sec.id === f.sectionId)
      const { snippet, ...range } = annotationFor(lines, f.quote, section?.title ?? title)
      return { id: `galley-${f.id}`, range, snippet, comment: findingComment(paper, f), created_at: at, updated_at: at }
    })
  writeReplacing(annotationsPath, JSON.stringify({ annotations: [...human, ...ours] }, null, 2))
  writeReplacing(join(dir, `${editorSlug(paper)}.proposals.json`), JSON.stringify({ proposals: (s.proposals ?? []).filter((p) => p.state === 'pending') }, null, 2))
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
      f.status = 'noted'
      paper.note('proposals', `You declined the changes proposed for ${f.id} (${f.question}).`)
    }
  }
  if (n) paper.save()
  return n
}

/** Text a person changed in the editor since galley last wrote it becomes their revision of the paper. */
export function importEditorEdits(paper: Paper): string[] {
  const s = paper.state
  const path = join(editorDir(paper), `${editorSlug(paper)}.md`)
  if (!existsSync(path) || !s.editorBase || !s.outline) return []
  const text = readFileSync(path, 'utf8')
  const author = paper.config.authors[0]?.name ?? 'the author'
  const changed: string[] = []
  const titleLine = text.match(/^# (.+)$/m)?.[1]?.trim()
  if (titleLine && titleLine !== s.editorBase.title && s.frame) { s.frame.title = titleLine; changed.push('title') }
  const blocks = text.split(/^## /m).slice(1).map((block) => {
    const newline = block.indexOf('\n')
    return { heading: block.slice(0, newline).trim(), body: block.slice(newline + 1).trim() }
  })
  const abstract = blocks.find((b) => b.heading === 'Abstract')
  if (abstract && s.frame && abstract.body !== s.editorBase.abstract.trim()) { s.frame.abstract = abstract.body; changed.push('abstract') }
  const rest = blocks.filter((b) => b !== abstract)
  s.outline.sections.forEach((section, i) => {
    const block = rest.find((b) => b.heading === section.title) ?? rest[i]
    if (!block) return
    const body = promote(block.body)
    if (body !== (s.editorBase![section.id] ?? '').trim()) {
      setPassageText(paper, section.id, body, author)
      changed.push(section.id)
    }
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
export function importHumanNotes(paper: Paper): number {
  const s = paper.state
  const path = join(editorDir(paper), `${editorSlug(paper)}.annotations.json`)
  if (!existsSync(path)) return 0
  const annotations: Annotation[] = JSON.parse(readFileSync(path, 'utf8')).annotations ?? []
  let added = 0
  for (const a of annotations) {
    if (a.id.startsWith('galley-') || s.findings.some((f) => f.id === `H-${a.id}`)) continue
    const comment = a.comment.trim()
    if (!comment) continue
    const assignee = /@(humans?|me)\b/i.test(comment) ? 'humans' : /@both\b/i.test(comment) ? 'both' : 'agents'
    const section = s.outline?.sections.find((sec) => squash(s.passages[sec.id]?.text ?? '').includes(squash(a.snippet).slice(0, 60)))
    s.findings.push({
      id: `H-${a.id}`, round: s.round, seat: 'human', family: paper.config.seats.challenger, model: 'human',
      severity: 'material', sectionId: section?.id ?? null, quote: a.snippet, question: comment.replace(/@(humans?|me|both|agents)\b/gi, '').trim(),
      alternatives: '', evidence: '', decision: comment, edit: null, status: 'open', assignee, origin: 'human', dispositions: [],
    })
    added++
  }
  if (added) paper.save()
  return added
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

## Claims the system added (${active.filter((c) => c.origin === 'system').length}). Stand behind each, or cut it
${list(active.filter((c) => c.origin === 'system').map((c) => `${c.id} [${c.status}] ${c.text}`), 'None.')}

## Claims stated as hypotheses for lack of evidence (${active.filter((c) => c.status === 'unsupported').length})
${list(active.filter((c) => c.status === 'unsupported').map((c) => `${c.id}: ${c.text}`), 'None.')}

## Claims narrowed to what their evidence supports (${active.filter((c) => c.status === 'narrowed').length})
${list(active.filter((c) => c.status === 'narrowed').map((c) => `${c.id}: ${c.text}`), 'None.')}

## Decisions made by a third model family, and notes left for you
${list(s.notes.filter((n) => n.forHuman).map((n) => n.text), 'None.')}

## Threads assigned to people
${list(s.findings.filter((f) => f.assignee === 'humans' && f.status === 'open').map((f) => `${f.id}: ${f.question}`), 'None.')}

## Steps skipped along the way
${list(s.notes.filter((n) => / was skipped /.test(n.text)).map((n) => `${n.behavior}: ${n.text}`), 'None.')}

${s.literature?.status === 'done' ? `## The systematic review
Question: ${s.literature.question}
Canary run ${s.literature.key}, searched ${s.literature.searchedOn}: ${s.literature.counts?.discovered} records identified, ${s.literature.counts?.screened} screened, ${s.literature.counts?.reviewed} read in full; ${s.literature.counts?.findings} findings, cited from ${s.literature.counts?.cited} publications. The full research bundle is ${s.literature.bundle}. Check that the question is the one you want answered; the findings appear in the claim ledger as "from the systematic review".

` : ''}${runsOf(paper).length ? `## Simulations: check what each one assumes
${runsOf(paper).map((r) => `${r.id} ${r.title} (${methodWords(r.result.method)}, ${sizeOf(r.result)}, seed ${r.result.provenance.seed}${r.result.provenance.ok ? '' : `; checks: ${r.result.provenance.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`})\n${r.result.spec.inputs.map((i) => `- ${i.name} ~ ${i.dist}: ${r.assumptions.find((a) => a.name === i.name)?.basis ?? 'no basis given'}`).join('\n')}`).join('\n\n')}

` : ''}## Your materials
${list((paper.config.materials ?? []).map((m) => `${m.id} ${m.kind} ${m.url ?? m.name}${m.kind === 'dataset' ? (m.private ? ': private, the models saw only its profile and the measurements' : ': shared, the models saw its profile and first rows') : ''}`), 'None.')}
${Object.values(s.measurements ?? {}).length ? `\nMeasurements galley computed from your data (check each against your own analysis):\n${Object.values(s.measurements ?? {}).map((m) => `- ${m.id}: ${m.summary}`).join('\n')}\n` : ''}

## Production record
${Object.entries(record).map(([k, v]) => `- ${PLACEHOLDERS[k] ?? LIT_PLACEHOLDERS[k] ?? k}: ${v}`).join('\n')}
`
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
  if (measurements.length) writeFileSync(join(root, 'measurements.json'), JSON.stringify(measurements.map((m) => ({ id: m.id, dataset: (paper.config.materials ?? []).find((x) => x.id === m.spec.dataset)?.name ?? m.spec.dataset, spec: m.spec, result: m.summary, n: m.n })), null, 2) + '\n')
  writeFileSync(join(root, 'README.md'), `# Evidence package\n\nThe claims of this manuscript, the evidence each rests on, and the verbatim passages of its sources, as Resolvent records (claims/, evidence/, sources/). Copy them into a Resolvent world model to admit them there.${measurements.length ? '\n\nmeasurements.json holds every number the manuscript states about the authors\' data, with the analysis that produced it.' : ''}\n`)
}

// ---------------------------------------------------------------- typeset

export function contentHash(paper: Paper): string {
  const s = paper.state
  return createHash('sha256').update(JSON.stringify({
    passages: Object.values(s.passages).map((p) => p.text), frame: s.frame, outcome: s.outcome,
    findings: s.findings.map((f) => [f.id, f.status, f.dispositions.length]), citations: s.citations.map((c) => [c.id, c.status]),
    figures: s.figures.map((f) => [f.id, f.status]), title: paper.config.title, authors: paper.config.authors, decl: paper.config.declarations,
  })).digest('hex').slice(0, 16)
}

export async function typeset(paper: Paper): Promise<string[]> {
  const build = paper.path('build')
  const out = paper.path('out')
  mkdirSync(build, { recursive: true })
  mkdirSync(out, { recursive: true })
  const { markdown, refs, record } = await buildManuscript(paper)
  writeFileSync(join(build, 'manuscript.md'), markdown)
  writeFileSync(join(build, 'refs.json'), JSON.stringify(refs, null, 2))
  const common = ['manuscript.md', '--citeproc', '--bibliography', 'refs.json', '--resource-path', build]
  const made: string[] = []
  await exec('pandoc', [...common, '-o', join(out, 'paper.pdf'), '--pdf-engine=typst', '-V', 'papersize=a4', '-V', 'fontsize=10.5pt', '-V', 'section-numbering=1.1'], build)
  made.push('paper.pdf')
  // The version many journals ask for at submission: line-numbered, with room between lines.
  try {
    await exec('pandoc', [...common, '-o', join(out, 'paper-review.pdf'), '--pdf-engine=typst', '-V', 'papersize=a4', '-V', 'fontsize=11pt', '-V', 'section-numbering=1.1',
      '-V', 'header-includes=#set par.line(numbering: "1", numbering-scope: "page")\n#set par(leading: 1.1em)'], build)
    made.push('paper-review.pdf')
  } catch (error) {
    paper.note('typeset', `paper-review.pdf was not produced: ${(error as Error).message.slice(0, 200)}`)
  }
  for (const [format, file] of [['latex', 'paper.tex'], ['docx', 'paper.docx'], ['typst', 'paper.typ']] as const) {
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
  }
  exportEvidence(paper)
  // The runnable reproduction of the paper's simulations: a reader reruns them and checks every simulated number with Node or a browser.
  // With no simulation left, an earlier package is cleared, so a dropped simulation is never published; one that does not verify is noted.
  const reproduction = join(out, 'simulation')
  if (runsOf(paper).length || existsSync(reproduction)) {
    try {
      writeReproduction(reproduction, runsOf(paper), {
        title: paper.config.title || paper.state.frame?.title,
        verified: (check) => { if (!check.ok) paper.note('typeset', `The simulation reproduction package does not verify: ${check.output.slice(-300)}`) },
      })
    } catch (error) { paper.note('typeset', `The simulation reproduction package was not written: ${(error as Error).message.slice(0, 200)}`) }
  }
  writeFileSync(join(out, 'signoff.md'), signoff(paper, record))
  // The editor's copy is a convenience: a failure to write it is noted, never a reason the paper stops.
  try { writeEditorDocument(paper) } catch (error) { paper.note('typeset', `The editor copy of the manuscript was not written: ${(error as Error).message.slice(0, 200)}`) }
  try {
    rmSync(join(out, 'submission.zip'), { force: true })
    await exec('zip', ['-qr', 'submission.zip', ...made, 'manuscript.md', 'refs.json', 'evidence', 'production-journal.jsonl', ...(existsSync(join(out, 'figures')) ? ['figures'] : []), ...(existsSync(join(out, 'simulation')) ? ['simulation'] : [])], out)
    made.push('submission.zip')
  } catch { /* the folder itself is the package */ }
  return made
}

export { claim }

export { fillPlaceholders, productionRecord }
