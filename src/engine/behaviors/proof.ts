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
import { activeClaims, live, manuscriptBlock, noteForAuthors, seatFamily, sectionText, setClaim } from './common.js'
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
    await run('pdftoppm', ['-r', '100', '-png', '-l', String(MAX_PAGES), pdf, join(dir, 'page')], dir)
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
  const sections = (paper.state.outline?.sections ?? []).map((section) => ({ id: section.id, raw: sectionText(paper, section.id), filled: fillPlaceholders(sectionText(paper, section.id), record).text }))
  for (const section of sections) {
    if (squash(section.filled).includes(q) || squash(section.raw).includes(q)) return section.id
  }
  // A quote from the printed page differs from the source where a citation, a cross-reference or mathematics is
  // printed: it comes from the section that holds the longest run of its words, when that run is long enough to tell
  // and no other section holds one as long.
  const words = plainWords(quote)
  let best: { id: string | null; run: number } = { id: null, run: 0 }
  for (const section of sections) {
    const hay = ` ${plainWords(section.filled).join(' ')} `
    let run = 0
    for (let i = 0; i < words.length && words.length - i > run; i++) {
      let j = i
      while (j < words.length && hay.includes(` ${words.slice(i, j + 1).join(' ')} `)) j++
      run = Math.max(run, j - i)
    }
    if (run > best.run) best = { id: section.id, run }
    else if (run === best.run) best = { id: null, run }
  }
  return best.run >= Math.min(6, Math.max(3, Math.ceil(words.length * 0.6))) ? best.id : null
}

/** A text's words, as a reader sees them: no citation keys, no mathematics, no markup or punctuation. */
function plainWords(text: string): string[] {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\[[^\]]*@[^\]]*\]|-?@[\w:.-]+/g, ' ').replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, ' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * The section a page shows, for a defect whose quote cannot be found in the source (a printed equation, say): the
 * last section whose heading is printed on that page or before it. Where a page begins a section partway down, the
 * section before it is on that page too, and is offered second.
 */
function sectionsOnPage(paper: Paper, pages: string[], page: number | null): string[] {
  if (!page || !pages.length) return []
  const sections = paper.state.outline?.sections ?? []
  const heading = (title: string, n: number) => new RegExp(`^\\s*${n}\\s+${title.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}`, 'm')
  const starts = sections.map((section, i) => pages.findIndex((text) => heading(section.title, i + 1).test(text)) + 1)
  let current = -1
  for (let i = 0; i < sections.length; i++) if (starts[i] > 0 && starts[i] <= page) current = i
  if (current < 0) return []
  const out = [sections[current].id]
  if (starts[current] === page && current > 0) out.push(sections[current - 1].id)
  return out
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

type Found = ProofDefect & { fixIn: typeof FIX_IN[number]; tableSection?: string }

/** The table a defect is about, by the number it names (0 for Table 1), or -1. */
function tableOf(defect: { quote: string; problem: string }): number {
  const number = `${defect.quote} ${defect.problem}`.match(/\btable\s*(\d+)/i)
  return number ? Number(number[1]) - 1 : -1
}

/**
 * Sentences in which the text doubts itself or talks about how it was made: who did or did not review it, what it
 * does not establish about its own readiness, which models did the work. None belongs in a paper; each is taken out
 * and kept for the authors as a comment. A paper about galley itself may name its models and steps.
 */
const SELF_TALK: { pattern: RegExp; aboutSystemToo: boolean }[] = [
  { pattern: /\b(?:no|not|without|never)\b[^.]{0,70}\b(?:person|people|human|humans|independent(?:ly)?|external|outside)\b[^.]{0,40}\b(?:review|reviewed|audit|audited|screen|screened|verif|check|checked|read)/i, aboutSystemToo: true },
  { pattern: /\bsubmission-ready means\b|\bmeans only that\b[^.]{0,60}\bgates?\b|\bgates? held\b/i, aboutSystemToo: true },
  { pattern: /\b(?:this|the) (?:manuscript|paper|text) (?:was|is|were) (?:produced|generated|written|drafted)\b/i, aboutSystemToo: false },
  { pattern: /\b(?:a|an|the) (?:research|language|independent) model\b|\b(?:GPT|Claude|Gemini)[- ]\d/i, aboutSystemToo: false },
]
export function selfTalk(text: string, aboutSystem = false): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((s) => s.trim()).filter((s) => SELF_TALK.some((r) => (aboutSystem ? r.aboutSystemToo : true) && r.pattern.test(s)))
}

/** A defect that says a figure or table is never referred to. */
const CALLOUT = /call(?:ed|s|ing)? out|callout|never (?:refer|mention|cite)|(?:does|do) not (?:refer|mention|cite)|without (?:referring|calling)/i

/** Whether the text refers to figure n: "Figure 3", "Fig. 3", "Figures 2 and 3", "Figures 1–3". */
export function calledOut(text: string, n: number, kind: 'figure' | 'table' = 'figure'): boolean {
  const names = kind === 'figure' ? /\b(?:Figures?|Figs?\.)\s+(\d+)((?:\s*(?:,|and|&|–|-|to)\s*\d+)*)/g : /\b(?:Tables?)\s+(\d+)((?:\s*(?:,|and|&|–|-|to)\s*\d+)*)/g
  for (const m of text.matchAll(names)) {
    const numbers = [Number(m[1]), ...[...m[2].matchAll(/\d+/g)].map((x) => Number(x[0]))]
    if (numbers.includes(n)) return true
    // A range: "Figures 1–3" refers to 2 as well.
    if (/–|-|to/.test(m[2]) && n > numbers[0] && n < numbers.at(-1)!) return true
  }
  return false
}

/** The tables the sections print, in the order they are numbered, each with the caption it prints under. */
export function printedTables(paper: Paper): { sectionId: string; caption: string }[] {
  return (paper.state.outline?.sections ?? []).flatMap((section) => {
    const lines = sectionText(paper, section.id).split('\n')
    const found: { sectionId: string; caption: string }[] = []
    lines.forEach((line, i) => {
      if (!/^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line) || !/^\|.*\|\s*$/.test(lines[i - 1] ?? '')) return
      // Its caption is the paragraph that starts "Table:" or ":" just after the table or just before it.
      let after = i + 1
      while (after < lines.length && /^\|.*\|\s*$/.test(lines[after])) after++
      while (after < lines.length && !lines[after].trim()) after++
      let before = i - 2
      while (before >= 0 && !lines[before].trim()) before--
      const caption = [lines[after], lines[before]].find((l) => /^(?:Table)?:\s/.test(l ?? '')) ?? ''
      found.push({ sectionId: section.id, caption: caption.replace(/^(?:Table)?:\s*/, '').trim() })
    })
    return found
  })
}

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
Do not judge the science, the argument or the prose style; other steps do that. The byline, affiliations and date are as the authors gave them: do not report them. For each defect give page, where (${WHERE.join(', ')}), quote (the exact printed text it concerns, or the figure's number), problem, fix (what the printed page should show instead), and fix_in: prose when the words of a section must change, figure when the figure itself must be drawn again, ledger for an entry of the claim ledger, other for anything else (layout, references, front matter, the production record). If the paper prints cleanly, return no defects.

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
        // The text never doubts itself or talks about its own making: each such sentence goes, and what it said is kept
        // for the authors beside the text.
        for (const sec of s.outline?.sections ?? []) {
          for (const sentence of selfTalk(sectionText(paper, sec.id), !!s.brief?.aboutSystem)) {
            defects.push({ page: null, where: 'section text', quote: sentence, problem: 'The text doubts itself or remarks on how it was produced or reviewed.', fix: 'Remove the sentence, or state the point it makes about the work plainly without the remark.', by: 'check', fixIn: 'prose' })
            noteForAuthors(paper, { sectionId: sec.id, quote: '', text: `Taken out of the text: "${sentence}"`, kind: 'caution', seat: 'checker', family: checker, behavior: 'proof' })
          }
        }
        // A figure the text never refers to is the text's to fix: drawing it again cannot add a callout. Each one is also
        // found mechanically, and sent to the figure's own section.
        for (const d of defects) if (d.fixIn === 'figure' && CALLOUT.test(d.problem)) d.fixIn = 'prose'
        const prose = (s.outline?.sections ?? []).map((sec) => sectionText(paper, sec.id)).join('\n')
        printedFigures(paper).forEach((fig, i) => {
          if (calledOut(prose, i + 1) || defects.some((d) => CALLOUT.test(d.problem) && figureOf(paper, d) === fig.id)) return
          defects.push({ page: null, where: 'figure', quote: `Figure ${i + 1}`, problem: `Figure ${i + 1} is never referred to in the text.`, fix: `Refer to it as Figure ${i + 1} in the sentence that discusses what it shows.`, by: 'check', figureId: fig.id, fixIn: 'prose' })
        })
        // So is a table the sections print: it is numbered in the order the sections print them.
        const tables = printedTables(paper)
        tables.forEach((table, i) => {
          if (calledOut(prose, i + 1, 'table') || defects.some((d) => CALLOUT.test(d.problem) && /\btable\b/i.test(`${d.quote} ${d.problem}`) && tableOf(d) === i)) return
          defects.push({ page: null, where: 'table', quote: `Table ${i + 1}`, problem: `Table ${i + 1}${table.caption ? ` (${table.caption.slice(0, 80)})` : ''} is never referred to in the text.`, fix: `Refer to it as Table ${i + 1} in the sentence that introduces what it shows.`, by: 'check', tableSection: table.sectionId, fixIn: 'prose' })
        })

        const rounds = (s.proof?.rounds ?? 0) + 1
        const left: ProofDefect[] = []
        let fixed = 0
        const keep = ({ fixIn: _, tableSection: __, ...d }: Found): ProofDefect => d
        if (rounds > PROOF_ROUNDS) left.push(...defects.map(keep))
        else {
          const prose = new Map<string, Found[]>()
          const ledger: Found[] = []
          for (const d of defects) {
            const fig = d.fixIn === 'figure' || d.where === 'figure' ? figureOf(paper, d) : null
            // A figure is drawn again only while a later reading can still send its new drawing back: a redraw on the
            // last such reading would print unread, and a drawing brings defects of its own.
            if (d.fixIn === 'figure' && fig && rounds < PROOF_ROUNDS) {
              // The figure is drawn again with the defect named.
              const figure = s.figures.find((f) => f.id === fig)!
              figure.revise = [figure.revise, `${d.problem} ${d.fix}`.trim()].filter(Boolean).join(' ')
              if (figure.status !== 'planned') figure.redraws = (figure.redraws ?? 0) + 1
              figure.status = 'planned'
              fixed++
            } else if (d.fixIn === 'ledger') ledger.push(d)
            else if (d.fixIn === 'prose' || d.where === 'equation') {
              // A missing callout or a wrong cross-reference has no quote in the prose: it belongs to the figure's or the
              // table's own section. A display equation is the section's own source, though printed it reads unlike it:
              // it is found by the page it is printed on.
              const table = d.where === 'table' ? tables[tableOf(d)]?.sectionId ?? null : null
              const section = sectionOf(paper, d.quote, record) ?? d.tableSection ?? table ?? (fig ? s.figures.find((f) => f.id === fig)?.sectionId ?? null : null)
                ?? sectionsOnPage(paper, pages.text, d.page).find((id) => d.where !== 'equation' || sectionText(paper, id).includes('$$')) ?? null
              if (section) prose.set(section, [...(prose.get(section) ?? []), d])
              else left.push(keep(d))
            } else left.push(keep(d))
          }
          const outline = (s.outline?.sections ?? []).map((sec, i) => `${i + 1} ${sec.title}`).join('\n')
          const figures = printedFigures(paper).map((f, i) => `Figure ${i + 1}: ${f.caption}`).join('\n')
          const tableList = tables.map((t, i) => `Table ${i + 1}: ${t.caption || '(no caption)'}`).join('\n')
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
${figures ? `\nThe figures as printed:\n${figures}\n` : ''}${tableList ? `\nThe tables as printed:\n${tableList}\n` : ''}
A display equation too wide for the column is set on several lines, as \\begin{aligned} with \\\\ between the lines and & before the sign they align at.

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
