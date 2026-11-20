// The typeset review. Once the paper is typeset, a family other than the
// author's reads it as a reader will: every page, as an image where that family
// can see one and as text in any case, alongside checks for what must never
// reach a page (placeholders, raw labels, unresolved references, blanks left for
// someone to fill). A defect in the prose goes back to the author, a defect in a
// figure goes back to the figure, an entry of the claim ledger at odds with the
// text is restated as the text states it, and the paper is typeset and read
// again. What the agents cannot fix is listed in the sign-off sheet.
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Paper } from '../paper.js'
import { HOUSE } from '../prompts.js'
import { fillPlaceholders, productionRecord, type Record_ } from '../record.js'
import { contentHash, writeSignoff } from '../render.js'
import type { Behavior } from '../scheduler.js'
import { arr, enm, int, nstr, obj, str } from '../schema.js'
import { applyExact, squash } from '../text.js'
import type { ProofDefect } from '../types.js'
import { reviewDone } from './close.js'
import { activeClaims, live, manuscriptBlock, seatFamily, sectionText, setClaim } from './common.js'
import { isNarrowing } from './truth.js'
import { setPassage } from './write.js'

/** Readings of the typeset paper that may still send defects back to be fixed; a later reading only records. */
export const PROOF_ROUNDS = 3
/** Pages looked at as images: enough for a full paper, bounded for one request. */
const MAX_PAGES = 40

/** What must never reach a printed page, whatever else the page says. */
const NEVER_PRINTED: { pattern: RegExp; problem: string }[] = [
  { pattern: /\{\{[^}\n]*\}\}/g, problem: 'an unfilled placeholder' },
  { pattern: /\{#(?:eq|fig|tbl|sec):[^}\n]*\}/g, problem: 'a raw cross-reference label' },
  { pattern: /@(?:eq|fig|tbl|sec):[\w:-]+/g, problem: 'an unresolved cross-reference' },
  { pattern: /\[not recorded\]/g, problem: 'a number the production record does not hold' },
  { pattern: /\?\?/g, problem: 'an unresolved reference mark' },
  { pattern: /\b(?:TODO|TBD|FIXME)\b/g, problem: 'a working note left in the text' },
  { pattern: /to be (?:declared|confirmed|completed|added) by the authors?|names? to be confirmed|\[insert [^\]]*\]/gi, problem: 'a blank left for the author to fill' },
]

/** Every place a text shows something that must never be printed, with a little of what surrounds it. */
export function printedDefects(text: string): { quote: string; context: string; problem: string }[] {
  const found = new Map<string, { quote: string; context: string; problem: string }>()
  for (const { pattern, problem } of NEVER_PRINTED) {
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0
      const context = text.slice(Math.max(0, at - 80), Math.min(text.length, at + m[0].length + 80)).replace(/\s+/g, ' ').trim()
      found.set(`${m[0]}|${context}`, { quote: m[0], context, problem })
    }
  }
  return [...found.values()]
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)))
}

/** The typeset PDF as a reader gets it: each page's text, and each page as an image when the tools for that are installed. */
async function pagesOf(paper: Paper): Promise<{ text: string[]; images: string[] }> {
  const pdf = paper.path('out', 'paper.pdf')
  const dir = paper.path('build', 'proof')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  let text: string[] = []
  try { text = (await run('pdftotext', ['-layout', pdf, '-'], dir)).split('\f').map((page) => page.trimEnd()).filter((page, i, all) => page || i < all.length - 1) } catch { /* the source text stands in below */ }
  let images: string[] = []
  try {
    await run('pdftoppm', ['-r', '70', '-png', '-l', String(MAX_PAGES), pdf, join(dir, 'page')], dir)
    // In page order by number, however the renderer pads it: page-2 before page-10.
    const page = (f: string) => Number(f.match(/\d+/)![0])
    images = readdirSync(dir).filter((f) => /^page-\d+\.png$/.test(f)).sort((a, b) => page(a) - page(b)).map((f) => join(dir, f))
  } catch { /* text only */ }
  return { text, images }
}

const WHERE = ['section text', 'figure', 'table', 'equation', 'references', 'front matter', 'appendix', 'other'] as const
/** Who can fix a defect: the words of a section, the figure itself, the claim ledger, or none of the agents (layout, references, the generated parts). */
const FIX_IN = ['prose', 'figure', 'ledger', 'other'] as const

/** The section whose printed text holds a quote: matched on the text as printed, with its numbers filled in. */
function sectionOf(paper: Paper, quote: string, record: Record_): string | null {
  const q = squash(quote)
  if (!q) return null
  for (const section of paper.state.outline?.sections ?? []) {
    if (squash(fillPlaceholders(sectionText(paper, section.id), record).text).includes(q) || squash(sectionText(paper, section.id)).includes(q)) return section.id
  }
  return null
}

/** The figures as printed, in order, so "Figure 3" names one. */
function printedFigures(paper: Paper) {
  return (paper.state.outline?.sections ?? []).flatMap((sec) => paper.state.figures.filter((f) => f.sectionId === sec.id && f.status === 'rendered'))
}

/** The figure a defect names: by its own id from the check, "Figure 3" by its printed number, or by words of its caption. */
function figureOf(paper: Paper, defect: { quote: string; problem: string; figureId?: string }): string | null {
  if (defect.figureId) return defect.figureId
  const printed = printedFigures(paper)
  const number = `${defect.quote} ${defect.problem}`.match(/\bfig(?:ure)?\.?\s*(\d+)/i)
  if (number) return printed[Number(number[1]) - 1]?.id ?? null
  const q = squash(defect.quote)
  return printed.find((f) => q && squash(f.caption).includes(q))?.id ?? null
}

type Found = ProofDefect & { fixIn: typeof FIX_IN[number] }

export const proof: Behavior = {
  id: 'proof', stage: 'close', improver: true, title: 'Read the typeset paper',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || s.outcome || paper.config.off.includes('proof')) return []
    if (!reviewDone(paper) || !paper.isSettled('frame:final')) return []
    const hash = contentHash(paper)
    if (!paper.isSettled(`typeset:${hash}`)) return []
    const reading = (s.proof?.rounds ?? 0) + 1
    return [{
      key: `proof:${hash}`, label: `the typeset paper, reading ${reading}`,
      run: async () => {
        const record = productionRecord(paper)
        const pages = await pagesOf(paper)
        const checker = seatFamily(paper, 'checker')
        const seesImages = checker === 'gpt' && pages.images.length > 0
        // Without the PDF's own text, the source it was typeset from stands in for it.
        const source = pages.text.length ? '' : fillPlaceholders((s.outline?.sections ?? []).map((sec) => `# ${sec.title}\n\n${sectionText(paper, sec.id)}`).join('\n\n'), record).text
        const reply = await paper.ask<any>({
          behavior: 'proof', target: hash, seat: 'checker', family: checker, images: seesImages ? pages.images : undefined,
          prompt: `${HOUSE}

You are the production editor. Below is the typeset paper as a reader will see it${seesImages ? ': its pages are attached as images, in order, and the text of each page follows' : pages.text.length ? ': the text of each printed page follows' : ': the text it was typeset from follows'}. Report every defect a reader would notice in how it is printed:
- text not meant to be printed: placeholders, template syntax, raw labels or cross-references, working notes, blanks left for someone to fill;
- cross-references that point to the wrong section, figure, table or equation, and figures or tables the text never refers to;
- equations that did not render, or render as code;
- figures whose text is a placeholder, garbled, overlapping, cut off or too small to read, or that do not show what their caption says;
- tables that overflow the page or break apart;
- an entry of the claim ledger appendix that says something the printed text does not (a result it does not report, a method it does not carry out);
- missing, duplicated or misnumbered headings; a reference list with broken entries.
Do not judge the science, the argument or the prose style; other steps do that. For each defect give page, where (${WHERE.join(', ')}), quote (the exact printed text it concerns, or the figure's number), problem, fix (what the printed page should show instead), and fix_in: prose when the words of a section must change, figure when the figure itself must be drawn again, ledger for an entry of the claim ledger, other for anything else (layout, references, front matter, the production record). If the paper prints cleanly, return no defects.

${pages.text.length ? pages.text.map((page, i) => `--- page ${i + 1} ---\n${page}`).join('\n\n') : source}`,
          schema: obj({ defects: arr(obj({ page: int(), where: enm([...WHERE]), quote: str(), problem: str(), fix: str(), fix_in: enm([...FIX_IN]) })) }),
        })
        const defects: Found[] = (reply.defects ?? []).map((d: any) => ({ page: Number(d.page) || null, where: d.where, quote: String(d.quote ?? ''), problem: String(d.problem ?? ''), fix: String(d.fix ?? ''), by: 'reader' as const, fixIn: FIX_IN.includes(d.fix_in) ? d.fix_in : 'other' }))
        // What no page may show is checked mechanically too, in the printed text and in every figure's source.
        const printed = pages.text.length ? pages.text.join('\n') : source
        for (const d of printedDefects(printed)) {
          if (defects.some((x) => x.quote.includes(d.quote))) continue
          const inProse = !!sectionOf(paper, d.context, record)
          defects.push({ page: null, where: inProse ? 'section text' : 'other', quote: d.context, problem: d.problem, fix: 'remove it, or write what it stands for', by: 'check', fixIn: inProse ? 'prose' : 'other' })
        }
        for (const fig of s.figures.filter((f) => f.status === 'rendered' && f.source)) {
          for (const d of printedDefects(fig.source!)) defects.push({ page: null, where: 'figure', quote: fig.caption.slice(0, 80), problem: `${d.problem} in the figure: ${d.quote}`, fix: 'draw the figure with the value itself', by: 'check', figureId: fig.id, fixIn: 'figure' })
        }

        const rounds = (s.proof?.rounds ?? 0) + 1
        const left: ProofDefect[] = []
        let fixed = 0
        const keep = ({ fixIn: _, ...d }: Found): ProofDefect => d
        if (rounds > PROOF_ROUNDS) left.push(...defects.map(keep))
        else {
          const prose = new Map<string, Found[]>()
          const ledger: Found[] = []
          for (const d of defects) {
            const fig = d.fixIn === 'figure' || d.where === 'figure' ? figureOf(paper, d) : null
            if (d.fixIn === 'figure' && fig) {
              // The figure is drawn again with the defect named.
              const figure = s.figures.find((f) => f.id === fig)!
              figure.revise = [figure.revise, `${d.problem} ${d.fix}`.trim()].filter(Boolean).join(' ')
              figure.status = 'planned'
              fixed++
            } else if (d.fixIn === 'ledger') ledger.push(d)
            else if (d.fixIn === 'prose') {
              // A missing callout or a wrong cross-reference has no quote in the prose: it belongs to the figure's own section.
              const section = sectionOf(paper, d.quote, record) ?? (fig ? s.figures.find((f) => f.id === fig)?.sectionId ?? null : null)
              if (section) prose.set(section, [...(prose.get(section) ?? []), d])
              else left.push(keep(d))
            } else left.push(keep(d))
          }
          const outline = (s.outline?.sections ?? []).map((sec, i) => `${i + 1} ${sec.title}`).join('\n')
          const figures = printedFigures(paper).map((f, i) => `Figure ${i + 1}: ${f.caption}`).join('\n')
          for (const [sectionId, found] of prose) {
            const section = s.outline!.sections.find((sec) => sec.id === sectionId)!
            const text = sectionText(paper, sectionId)
            const author = seatFamily(paper, 'author')
            const answer = await paper.ask<any>({
              behavior: 'proof', target: `${hash}:${sectionId}`, seat: 'author', family: author,
              prompt: `${HOUSE}

The typeset paper shows these defects in section ${section.id} ${section.title}. Fix each with exact edits to the section's source text below: old is copied character for character from it, and {{placeholders}} stay as they are where they belong. Change nothing else.

${found.map((d, i) => `${i + 1}. "${d.quote}": ${d.problem} Fix: ${d.fix}`).join('\n')}

The sections as printed, by number:
${outline}
${figures ? `\nThe figures as printed:\n${figures}\n` : ''}
SOURCE TEXT:
"""
${text}
"""`,
              schema: obj({ edits: arr(obj({ old: str(), new: str() })) }),
            })
            let next = text
            for (const edit of answer.edits ?? []) {
              const changed = applyExact(next, edit)
              if (changed !== null) next = changed
            }
            if (next !== text) {
              setPassage(paper, sectionId, next, { kind: 'agent', family: author, model: paper.config.models[author]?.model ?? author, seat: 'author', behavior: 'proof' }, `defects found in the typeset paper`)
              // The next reading checks the printed page itself.
              fixed += found.length
            } else left.push(...found.map(keep))
          }
          if (ledger.length) fixed += await restateLedger(paper, hash, ledger, record, left)
        }
        s.proof = { rounds, hash, defects: defects.map(keep), fixed: (s.proof?.fixed ?? 0) + fixed, left }
        paper.journal({ event: 'proof', hash, round: rounds, defects: defects.length, fixed, left: left.length, images: seesImages ? pages.images.length : 0 })
        paper.save()
        // The sign-off sheet says what the reading left for a person.
        writeSignoff(paper)
      },
    }]
  },
}

/**
 * Ledger entries the reader found at odds with the printed text are judged again
 * against the whole manuscript, as the reconcile step does: restated as the text
 * states them, or dropped as no longer stated. Returns how many were settled.
 */
async function restateLedger(paper: Paper, hash: string, found: Found[], record: Record_, left: ProofDefect[]): Promise<number> {
  const claims = activeClaims(paper)
  const matched = found.map((d) => ({ d, c: claims.find((c) => squash(fillPlaceholders(c.text, record).text).includes(squash(d.quote)) || squash(c.text).includes(squash(d.quote))) }))
  for (const { d, c } of matched) if (!c) left.push((({ fixIn: _, ...rest }) => rest)(d))
  const entries = matched.filter((m) => m.c)
  if (!entries.length) return 0
  const reply = await paper.ask<any>({
    behavior: 'proof', target: `${hash}:ledger`, seat: 'checker', family: seatFamily(paper, 'checker'),
    prompt: `${HOUSE}

A reader of the typeset paper found these entries of its claim ledger at odds with the printed text. For each claim, say how the manuscript's sections state it now.
- stated: the text states it as the ledger has it.
- narrowed: the text states only a narrower or weaker version. Give narrowed: the claim reworded to exactly what the text states, in the claim's own terms.
- absent: the text does not state it, not even as a hypothesis or an open question.
Give quote: the sentence of the text that states it, copied exactly (empty when absent).

${entries.map(({ d, c }) => `${c!.id}: ${c!.text}\n  the reader: ${d.problem}`).join('\n')}

MANUSCRIPT:
${manuscriptBlock(paper, false, false)}`,
    schema: obj({ items: arr(obj({ claim_id: str(), how: enm(['stated', 'narrowed', 'absent']), quote: str(), narrowed: nstr() })) }),
  })
  let settled = 0
  for (const item of reply.items ?? []) {
    const c = claims.find((k) => k.id === item.claim_id)
    if (!c) continue
    if (item.how === 'absent') { setClaim(paper, c, 'dropped', 'proof', 'not stated in the printed text'); settled++ }
    else if (item.how === 'narrowed' && item.narrowed && isNarrowing(c.text, item.narrowed)) { setClaim(paper, c, c.status, 'proof', `the printed text states it more narrowly: "${String(item.quote).slice(0, 300)}"`, item.narrowed); settled++ }
  }
  return settled
}
