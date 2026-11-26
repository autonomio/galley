// The typeset review. Once the paper is typeset, a family other than the
// author's reads it as a reader will: every page, as an image where that family
// can see one and as text in any case, alongside checks for what must never
// reach a page (placeholders, raw labels, unresolved references, blanks left for
// someone to fill). A defect in the prose goes back to the author, a defect in a
// figure goes back to the figure, an entry of the claim ledger at odds with the
// text is restated as the text states it, and the paper is typeset and read
// again. What the agents cannot fix is listed in the sign-off sheet.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { blockText, sourceDigest, type PrintedBlock } from '../blocks.js'
import { reviewBlocks } from '../literature.js'
import type { Paper } from '../paper.js'
import { HOUSE } from '../prompts.js'
import { fillPlaceholders, productionRecord, type Record_ } from '../record.js'
import { availabilityBlock, contentHash, FIGURE_WIDTHS, TABLE_LEVELS, tableKey, writeSignoff } from '../render.js'
import type { Behavior } from '../scheduler.js'
import { arr, bool, enm, int, nstr, obj, str } from '../schema.js'
import { applyExact, citedKeys, squash } from '../text.js'
import type { ProofDefect, Work } from '../types.js'
import { reviewDone } from './close.js'
import { activeClaims, live, manuscriptBlock, noteForAuthors, seatFamily, sectionText, setClaim } from './common.js'
import { storyReadDone } from './story.js'
import { isNarrowing } from './truth.js'
import { setPassage } from './write.js'

/** Readings of the typeset paper that may still send defects back to be fixed; a later reading only records. */
export const PROOF_ROUNDS = 4
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
/**
 * Who can fix a defect: the words of a section, the figure itself, how a table or figure is set on its page, a part the
 * system writes from its records (the review's protocol, the availability statement), the claim ledger, or else none.
 */
const FIX_IN = ['prose', 'figure', 'layout', 'generated', 'ledger', 'other'] as const
const SEVERITY = ['P0', 'P1', 'P2', 'P3'] as const
/** Where a defect is not in the body's text: no section's words are on its page. */
const BACK = ['appendix', 'references', 'front matter']
/** A defect in how a table or a figure sits on its page, however a reader classed it. */
const LAYOUT = /overlap|overprint|collid|cut off|clipped|overflow|overrun|runs? (?:off|past|into)|(?:past|beyond) the (?:page|margin|edge|bottom)|separated from|stranded|apart from/i

/** The section whose printed text holds a quote: matched on the text as printed, with its numbers filled in. */
function sectionOf(paper: Paper, quote: string, record: Record_): string | null {
  const q = squash(quote)
  if (!q) return null
  const sections = (paper.state.outline?.sections ?? []).map((section) => ({ id: section.id, raw: sectionText(paper, section.id), filled: fillPlaceholders(sectionText(paper, section.id), record).text }))
  for (const section of sections) {
    if (squash(section.filled).includes(q) || squash(section.raw).includes(q)) return section.id
  }
  // A quote from the printed page differs from the source where a citation, a cross-reference or mathematics is
  // printed: it comes from the section that holds the longest run of its words.
  return longestRun(quote, sections.map((section) => ({ id: section.id, text: section.filled })))
}

/** Of several texts, the one holding the longest run of a quote's words, when that run is long enough to tell and no other text holds one as long. */
function longestRun(quote: string, texts: { id: string; text: string }[]): string | null {
  const words = plainWords(quote)
  let best: { id: string | null; run: number } = { id: null, run: 0 }
  for (const candidate of texts) {
    const hay = ` ${plainWords(candidate.text).join(' ')} `
    let run = 0
    for (let i = 0; i < words.length && words.length - i > run; i++) {
      let j = i
      while (j < words.length && hay.includes(` ${words.slice(i, j + 1).join(' ')} `)) j++
      run = Math.max(run, j - i)
    }
    if (run > best.run) best = { id: candidate.id, run }
    else if (run === best.run) best = { id: null, run }
  }
  return best.run >= Math.min(6, Math.max(3, Math.ceil(words.length * 0.6))) ? best.id : null
}

/** The parts the system prints from its records, as this paper prints them. */
export function printedBlocks(paper: Paper): PrintedBlock[] {
  // The availability statement the authors declared themselves is theirs, not the system's.
  return [...reviewBlocks(paper), ...(paper.config.declarations?.availability?.trim() ? [] : [availabilityBlock(paper)])]
}

/** The part a quote is printed in, by its words. */
function blockOf(paper: Paper, blocks: PrintedBlock[], quote: string): PrintedBlock | null {
  const q = squash(quote)
  if (!q) return null
  const texts = blocks.map((block) => ({ id: block.id, text: blockText(paper, block) }))
  const id = texts.find((t) => squash(t.text).includes(q))?.id ?? longestRun(quote, texts)
  return blocks.find((block) => block.id === id) ?? null
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
function figureOf(paper: Paper, defect: { quote: string; problem: string; figureId?: string }, printed = printedFigures(paper)): string | null {
  if (defect.figureId) return defect.figureId
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
    // The told paper is read through before it is proofread as printed.
    if (!storyReadDone(paper)) return []
    const hash = contentHash(paper)
    if (!paper.isSettled(`typeset:${hash}`)) return []
    const reading = (s.proof?.rounds ?? 0) + 1
    return [{
      key: `proof:${hash}`, label: `the typeset paper, reading ${reading}`,
      run: async () => {
        const record = productionRecord(paper)
        const pages = await pagesOf(paper)
        // The figures as this paper printed them: a figure sent back to be drawn again below is still the one its
        // number names on the page.
        const shown = printedFigures(paper)
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
Do not judge the science, the argument or the prose style; other steps do that. A figure or table set at the top or bottom of a page, with the text running on around it and past it, sits where typeset papers place them: do not report its position. The byline, affiliations and date are as the authors gave them: do not report them. For each defect give page, where (${WHERE.join(', ')}), quote (the exact printed text it concerns, or the figure's or the table's number), problem, fix (what the printed page should show instead), severity and fix_in.
severity: P0 when the page prints what must never be printed (an instruction, a working note, a placeholder, a raw label) or states something wrong; P1 when a reader would see an error: text overprinted or cut off, a table or a caption apart from its body, a broken cross-reference, a garbled reference entry, an author's name printed wrongly or in two forms, a statement at odds with a table or figure of the paper; P2 for what a careful copy editor would fix; P3 for a matter of taste. A paragraph, a table or a reference entry that runs on onto the next page is printed as typeset papers are: P3 at most.
fix_in: prose when the words of a section must change, also when what a section says disagrees with a table or figure it describes; figure when the figure itself must be drawn again; layout when a table, a figure or its caption does not fit its page (overprinted, cut off, run past the page, apart from its caption); generated for the words of a part the system writes from its records (the literature review's protocol, the data and code availability statement, the production record); ledger for an entry of the claim ledger; other for anything else (references, front matter). If the paper prints cleanly, return no defects.

${pages.text.length ? pages.text.map((page, i) => `--- page ${i + 1} ---\n${page}`).join('\n\n') : source}`,
          schema: obj({ defects: arr(obj({ page: int(), where: enm([...WHERE]), quote: str(), problem: str(), fix: str(), severity: enm([...SEVERITY]), fix_in: enm([...FIX_IN]) })) }),
        })
        const defects: Found[] = (reply.defects ?? []).map((d: any) => ({ page: Number(d.page) || null, where: d.where, quote: String(d.quote ?? ''), problem: String(d.problem ?? ''), fix: String(d.fix ?? ''), by: 'reader' as const, severity: SEVERITY.includes(d.severity) ? d.severity : 'P1', fixIn: FIX_IN.includes(d.fix_in) ? d.fix_in : 'other' }))
        // What no page may show is checked mechanically too, in the printed text and in every figure's source.
        const printed = pages.text.length ? pages.text.join('\n') : source
        for (const d of printedDefects(printed)) {
          if (defects.some((x) => x.quote.includes(d.quote))) continue
          const inProse = !!sectionOf(paper, d.context, record)
          defects.push({ page: null, where: inProse ? 'section text' : 'other', quote: d.context, problem: d.problem, fix: 'remove it, or write what it stands for', by: 'check', severity: 'P0', fixIn: inProse ? 'prose' : 'other' })
        }
        for (const fig of s.figures.filter((f) => f.status === 'rendered' && f.source)) {
          for (const d of printedDefects(fig.source!)) defects.push({ page: null, where: 'figure', quote: fig.caption.slice(0, 80), problem: `${d.problem} in the figure: ${d.quote}`, fix: 'draw the figure with the value itself', by: 'check', severity: 'P0', figureId: fig.id, fixIn: 'figure' })
        }
        // The text never doubts itself or talks about its own making: each such sentence goes, and what it said is kept
        // for the authors beside the text.
        for (const sec of s.outline?.sections ?? []) {
          for (const sentence of selfTalk(sectionText(paper, sec.id), !!s.brief?.aboutSystem)) {
            defects.push({ page: null, where: 'section text', quote: sentence, problem: 'The text doubts itself or remarks on how it was produced or reviewed.', fix: 'Remove the sentence, or state the point it makes about the work plainly without the remark.', by: 'check', severity: 'P1', fixIn: 'prose' })
            noteForAuthors(paper, { sectionId: sec.id, quote: '', text: `Taken out of the text: "${sentence}"`, kind: 'caution', seat: 'checker', family: checker, behavior: 'proof' })
          }
        }
        // A figure the text never refers to is the text's to fix: drawing it again cannot add a callout. Each one is also
        // found mechanically, and sent to the figure's own section.
        for (const d of defects) if (d.fixIn === 'figure' && CALLOUT.test(d.problem)) d.fixIn = 'prose'
        // A figure is referred to in the section it belongs to, which discusses what it shows; a mention elsewhere alone
        // leaves the reader of that section without it.
        shown.forEach((fig, i) => {
          if (calledOut(sectionText(paper, fig.sectionId), i + 1) || defects.some((d) => CALLOUT.test(d.problem) && figureOf(paper, d, shown) === fig.id)) return
          defects.push({ page: null, where: 'figure', quote: `Figure ${i + 1}`, problem: `Figure ${i + 1} is never referred to in the section that discusses what it shows.`, fix: `Refer to it as Figure ${i + 1} in the sentence of that section that discusses what it shows.`, by: 'check', severity: 'P2', figureId: fig.id, fixIn: 'prose' })
        })
        // So is a table the sections print: it is numbered in the order the sections print them.
        const tables = printedTables(paper)
        tables.forEach((table, i) => {
          if (calledOut(sectionText(paper, table.sectionId), i + 1, 'table') || defects.some((d) => CALLOUT.test(d.problem) && /\btable\b/i.test(`${d.quote} ${d.problem}`) && tableOf(d) === i)) return
          defects.push({ page: null, where: 'table', quote: `Table ${i + 1}`, problem: `Table ${i + 1}${table.caption ? ` (${table.caption.slice(0, 80)})` : ''} is never referred to in the section it is printed in.`, fix: `Refer to it as Table ${i + 1} in the sentence that introduces what it shows.`, by: 'check', severity: 'P2', tableSection: table.sectionId, fixIn: 'prose' })
        })

        const rounds = (s.proof?.rounds ?? 0) + 1
        const left: ProofDefect[] = []
        let fixed = 0
        const keep = ({ fixIn: _, tableSection: __, ...d }: Found): ProofDefect => d
        if (rounds > PROOF_ROUNDS) left.push(...defects.map(keep))
        else {
          const prose = new Map<string, Found[]>()
          const ledger: Found[] = []
          const references: Found[] = []
          // The parts the system prints from its records, each found by the words a reader quotes from it, and what
          // this reading sends back to be written again from them.
          const blocks = printedBlocks(paper)
          const generated = new Map<string, Found[]>()
          // A table or figure set one step further to fit its page is set so once in a reading, however many defects name it.
          const refit = new Set<string>()
          for (const d of defects) {
            const fig = d.fixIn === 'figure' || d.where === 'figure' ? figureOf(paper, d, shown) : null
            // A figure is drawn again on any reading that can still fix things: the reading after it, the recording one at
            // the latest, reads the new drawing.
            const chartOff = s.figures.find((f) => f.id === fig)?.kind === 'chart' && (paper.config.off.includes('story-charts') || paper.config.off.includes('story'))
            if (d.fixIn === 'figure' && fig && !chartOff) {
              // The figure is drawn again with the defect named.
              const figure = s.figures.find((f) => f.id === fig)!
              figure.revise = [figure.revise, `${d.problem} ${d.fix}`.trim()].filter(Boolean).join(' ')
              if (figure.status !== 'planned') figure.redraws = (figure.redraws ?? 0) + 1
              figure.status = 'planned'
              fixed++
              continue
            }
            if (d.fixIn === 'ledger') { ledger.push(d); continue }
            if (d.where === 'references') { references.push(d); continue }
            // How a table or a figure sits on its page is the typesetting's to fix: it is set one step further to fit.
            if (d.fixIn === 'layout' || (d.fixIn === 'other' && (d.where === 'table' || d.where === 'figure') && LAYOUT.test(d.problem))) {
              if (setToFit(paper, d, fig, pages.text, refit)) fixed++
              else left.push(keep(d))
              continue
            }
            // Words the system printed from its records are written again from those records; a section's words are its
            // author's.
            const inSection = sectionOf(paper, d.quote, record)
            const block = inSection ? null : blockOf(paper, blocks, d.quote)
            if (block && d.fixIn !== 'figure') {
              generated.set(block.id, [...(generated.get(block.id) ?? []), d])
              continue
            }
            if (d.fixIn === 'prose' || d.where === 'equation') {
              // A missing callout or a wrong cross-reference has no quote in the prose: it belongs to the figure's or the
              // table's own section. A display equation is the section's own source, though printed it reads unlike it:
              // it is found by the page it is printed on.
              const table = d.where === 'table' ? tables[tableOf(d)]?.sectionId ?? null : null
              // A bare "Figure 3" or "Table 2" names the figure or the table, not words of a section, wherever else the
              // number is printed: such a defect, a missing callout above all, goes to the figure's or the table's own section.
              const bare = /^(?:fig(?:ure)?|table)\.?\s*\d+\.?$/i.test(d.quote.trim())
              const own = d.tableSection ?? table ?? (fig ? s.figures.find((f) => f.id === fig)?.sectionId ?? null : null)
              // The page tells the section only in the body: an appendix's or the references' page holds no section's words.
              const onPage = BACK.includes(d.where) ? [] : sectionsOnPage(paper, pages.text, d.page)
              const section = (bare ? null : inSection) ?? own ?? onPage.find((id) => d.where !== 'equation' || sectionText(paper, id).includes('$$')) ?? null
              if (section) prose.set(section, [...(prose.get(section) ?? []), d])
              else left.push(keep(d))
            } else left.push(keep(d))
          }
          const outline = (s.outline?.sections ?? []).map((sec, i) => `${i + 1} ${sec.title}`).join('\n')
          const figures = shown.map((f, i) => `Figure ${i + 1}: ${f.caption}`).join('\n')
          const tableList = tables.map((t, i) => `Table ${i + 1}: ${t.caption || '(no caption)'}`).join('\n')
          for (const [sectionId, found] of prose) {
            const section = s.outline!.sections.find((sec) => sec.id === sectionId)!
            const text = sectionText(paper, sectionId)
            const author = seatFamily(paper, 'author')
            const answer = await paper.ask<any>({
              behavior: 'proof', target: `${hash}:${sectionId}`, seat: 'author', family: author,
              prompt: `${HOUSE}

The typeset paper shows these defects in section ${section.id} ${section.title}. Fix each with exact edits to the section's source text below: old is copied character for character from it, and {{placeholders}} stay as they are where they belong. A citation is written only as [@key], with a key the paper already cites; never as a link or as the words it prints as. How a reference prints (its authors, year or title) comes from its record, not from the prose: do not change a citation to fix it. Change nothing else.

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
            // A key the paper does not cite, or a citation written by hand as a link, is not an edit to make: it prints
            // as a raw key or a broken link.
            const keys = new Set([...Object.values(s.passages).flatMap((p) => citedKeys(p.text)), ...shown.flatMap((f) => citedKeys(f.caption))])
            for (const edit of answer.edits ?? []) {
              const written = String(edit.new ?? '')
              if (/\]\(#ref-/.test(written) || citedKeys(written).some((k) => !keys.has(k))) continue
              const changed = applyExact(next, edit)
              if (changed !== null) next = changed
            }
            if (next !== text) {
              setPassage(paper, sectionId, next, { kind: 'agent', family: author, model: paper.modelFor({ seat: 'author', family: author }).model, seat: 'author', behavior: 'proof' }, `defects found in the typeset paper`)
              // The next reading checks the printed page itself.
              fixed += found.length
            } else left.push(...found.map(keep))
          }
          if (ledger.length) fixed += await restateLedger(paper, hash, ledger, record, left)
          if (references.length) fixed += await correctReferences(paper, hash, references, left)
          if (generated.size) fixed += await rewriteBlocks(paper, hash, generated, blocks, left)
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

/** The tables the typeset paper printed, in the order they are numbered, each by its header row: only a table with a caption is numbered. */
function printedTableKeys(paper: Paper): string[] {
  const path = paper.path('out', 'manuscript.md')
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n')
  const row = /^\|.*\|\s*$/
  const caption = /^(?:Table)?:\s/
  const keys: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!row.test(lines[i]) || !/^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[i + 1] ?? '') || row.test(lines[i - 1] ?? '')) continue
    let after = i + 2
    while (after < lines.length && row.test(lines[after])) after++
    while (after < lines.length && !lines[after].trim()) after++
    let before = i - 1
    while (before >= 0 && !lines[before].trim()) before--
    if (caption.test(lines[after] ?? '') || caption.test(lines[before] ?? '')) keys.push(tableKey(lines[i]))
  }
  return keys
}

/** The table whose caption a page prints, when a reader names none: on that page, or on the one after or before it. */
function tableOnPage(pages: string[], page: number | null): number {
  for (const p of page ? [page, page + 1, page - 1] : []) {
    const m = pages[p - 1]?.match(/^\s*Table\s+(\d+)\s*[:.]/m)
    if (m) return Number(m[1]) - 1
  }
  return -1
}

/**
 * Sets a table or a figure a reading found not to fit its page one step further: a table in smaller type, then on a
 * page turned to landscape, then both; a figure narrower, so it and its caption fit. False when there is no step left.
 */
function setToFit(paper: Paper, d: Found, fig: string | null, pages: string[], refit: Set<string>): boolean {
  const s = paper.state
  if (d.where === 'figure') {
    if (!fig) return false
    if (refit.has(`figure:${fig}`)) return true
    const level = s.layout?.figures?.[fig] ?? 0
    if (level >= FIGURE_WIDTHS.length - 1) return false
    s.layout = { ...s.layout, figures: { ...s.layout?.figures, [fig]: level + 1 } }
    refit.add(`figure:${fig}`)
    return true
  }
  const n = tableOf(d) >= 0 ? tableOf(d) : tableOnPage(pages, d.page)
  const key = printedTableKeys(paper)[n]
  if (!key) return false
  if (refit.has(`table:${key}`)) return true
  const level = s.layout?.tables?.[key] ?? 0
  if (level >= TABLE_LEVELS.length) return false
  s.layout = { ...s.layout, tables: { ...s.layout?.tables, [key]: level + 1 } }
  refit.add(`table:${key}`)
  return true
}

/**
 * Parts the system printed from its records that a reader found printed wrongly are written again by the author family
 * from the same records, as the paper's own text, and another family checks the new text against them. Returns how
 * many defects the accepted texts fix; the rest are left for the authors.
 */
async function rewriteBlocks(paper: Paper, hash: string, found: Map<string, Found[]>, blocks: PrintedBlock[], left: ProofDefect[]): Promise<number> {
  const strip = ({ fixIn: _, tableSection: __, ...d }: Found): ProofDefect => d
  const author = seatFamily(paper, 'author')
  const checker = seatFamily(paper, 'checker')
  let fixed = 0
  for (const [id, defects] of found) {
    const block = blocks.find((b) => b.id === id)
    if (!block) { left.push(...defects.map(strip)); continue }
    const current = blockText(paper, block)
    const listed = defects.map((d, i) => `${i + 1}. "${d.quote}": ${d.problem} Fix: ${d.fix}`).join('\n')
    const records = JSON.stringify(block.source, null, 2)
    const answer = await paper.ask<any>({
      behavior: 'proof', target: `${hash}:block:${id}`, seat: 'author', family: author,
      prompt: `${HOUSE}

The system prints ${block.label} from the records below. A reader of the typeset paper found these defects in it:
${listed}

Write it again from its records, as the paper's own text in the register of the rest of the paper. State what the records say, in sentences a reader of the paper understands. Records written for the agents that did the work (an instruction to them, a working note, a log, shorthand) are reported as what was done or decided, never as an instruction. Keep every fact of the current text that the records hold, and add none they do not hold. Keep its bold lead-in, and every citation exactly as it is written ([@key]).

CURRENT TEXT:
"""
${current}
"""

RECORDS:
${records}`,
      schema: obj({ text: str() }),
    })
    const text = String(answer.text ?? '').trim()
    const keys = new Set(citedKeys(current))
    if (!text || text === current || citedKeys(text).some((k) => !keys.has(k))) { left.push(...defects.map(strip)); continue }
    const check = await paper.ask<any>({
      behavior: 'proof', target: `${hash}:block:${id}:check`, seat: 'checker', family: checker,
      prompt: `${HOUSE}

The system printed ${block.label} as the current text below, from the records below. A reader found these defects in it:
${listed}

The author has written it again as the new text. Is the new text faithful: does it state only what the records hold, keep every fact of the current text that the records hold, and fix each defect? If not, say what is wrong.

CURRENT TEXT:
"""
${current}
"""

NEW TEXT:
"""
${text}
"""

RECORDS:
${records}`,
      schema: obj({ faithful: bool(), problem: str() }),
    })
    if (check.faithful !== true) { left.push(...defects.map(strip)); continue }
    paper.state.blocks = { ...paper.state.blocks, [id]: { text, source: sourceDigest(block.source), family: author } }
    fixed += defects.length
  }
  return fixed
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

/** The types a reference can be given, and the fields of its record a reading may correct. */
const CSL_TYPES = ['article', 'article-journal', 'article-magazine', 'article-newspaper', 'book', 'chapter', 'dataset', 'entry-encyclopedia', 'manuscript', 'paper-conference', 'patent', 'report', 'software', 'speech', 'standard', 'thesis', 'webpage']
const RECORD_FIELDS = ['type', 'container-title', 'collection-title', 'collection-number', 'event-title', 'volume', 'issue', 'page', 'number', 'publisher', 'publisher-place', 'genre', 'edition']
/** What of a registry's record says where a work was published: the rest (its abstract, its own references) is not shown. */
const WHERE_PUBLISHED = [...RECORD_FIELDS, 'title', 'event', 'event-place', 'original-title', 'short-container-title', 'container-title-short', 'ISBN', 'ISSN']
const published = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([key]) => WHERE_PUBLISHED.includes(key)))

/**
 * Entries of the reference list the reader found printed wrongly are corrected in their citation records: a field
 * retyped, moved or removed, never one invented. A value set must already be in the record, as its registry gave it.
 * Returns how many defects were corrected; the rest are left for the authors.
 */
async function correctReferences(paper: Paper, hash: string, found: Found[], left: ProofDefect[]): Promise<number> {
  const strip = ({ fixIn: _, tableSection: __, ...d }: Found): ProofDefect => d
  const path = paper.path('build', 'refs.json')
  const printed: Record<string, unknown>[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  const works = new Map(Object.values(paper.state.works).filter((w) => w.bibKey).map((w) => [w.bibKey!, w]))
  // A work with no registry record is described by what the index says of it: the opening of its abstract and its
  // author's institution say whether it is a thesis, a report or a book, and where it was written.
  const indexed = (id: unknown): Record<string, string> | null => {
    const work = works.get(String(id))
    if (!work || work.csl) return null
    const said = Object.entries({ abstract: work.abstract?.slice(0, 400) ?? '', institution: work.institution ?? '' }).filter(([, v]) => v.trim())
    return said.length ? Object.fromEntries(said) : null
  }
  const reply = await paper.ask<any>({
    behavior: 'proof', target: `${hash}:references`, seat: 'author', family: seatFamily(paper, 'author'),
    prompt: `${HOUSE}

A reader of the typeset paper found these entries of its reference list printed wrongly. The list is typeset in Chicago author-date style from the citation records below. For each defect, give the record it concerns (id) and how to correct that record so its entry prints as the publication it is: fields to set and fields to remove. A value you set must already be in that record, moved from another field, copied from a field the style does not print, or taken from what the index says of a work that has no registry record (its index: the opening of its abstract and its author's institution, as where a thesis was written); only type may take any of these values: ${CSL_TYPES.join(', ')}. Never invent a title, volume, page, editor, publisher or venue. Where the record does not hold what is missing, remove what prints wrongly. Fields you may set or remove: ${RECORD_FIELDS.join(', ')}. A defect no record can fix gets no correction.
An author's name printed wrongly (given and family names swapped, a name cut short, one person printed in two forms in different entries) is corrected by giving all of that record's authors, in order, each as family and given, with name parts that already appear: in that record, in the authors its index lists (index_authors), or in another entry of this list for the same person. Give authors only to correct a name; otherwise leave them empty.

DEFECTS:
${found.map((d, i) => `${i + 1}. "${d.quote}": ${d.problem}`).join('\n')}

RECORDS:
${printed.map((r) => { const work = works.get(String(r.id)); const raw = work?.csl; const index = indexed(r.id); return JSON.stringify({ ...r, ...(raw ? { registry: published(raw) } : {}), ...(index ? { index } : {}), ...(work?.authors.length ? { index_authors: work.authors } : {}) }) }).join('\n')}`,
    schema: obj({ corrections: arr(obj({ defect: int(), id: str(), set: arr(obj({ field: str(), value: str() })), remove: arr(str()), authors: arr(obj({ family: str(), given: str() })) })) }),
  })
  const corrected = new Set<number>()
  // What the index says of each work, as the reader was shown it before any record changed.
  const shownIndex = new Map(printed.map((r) => [String(r.id), indexed(r.id)]))
  // Every name part the paper's records hold, as each was shown before any record changed: an author's name is
  // corrected only with these, so no name is invented.
  const names = namesHeld(printed, [...works.values()])
  for (const fix of reply.corrections ?? []) {
    const n = Number(fix.defect)
    const work = works.get(String(fix.id))
    if (!work || !found[n - 1]) continue
    const entry = printed.find((r) => r.id === fix.id) ?? {}
    const record: Record<string, unknown> = work.csl ?? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'id'))
    const holds = squash(JSON.stringify([published(record), entry, shownIndex.get(String(fix.id)) ?? {}]))
    const changes: string[] = []
    for (const { field, value } of fix.set ?? []) {
      const v = String(value ?? '').trim()
      if (!RECORD_FIELDS.includes(field) || !v || (field === 'type' ? !CSL_TYPES.includes(v) : !holds.includes(squash(v)))) continue
      record[field] = v
      changes.push(`set ${field}`)
    }
    for (const field of fix.remove ?? []) {
      if (!RECORD_FIELDS.includes(field) || field === 'type' || !(field in record)) continue
      delete record[field]
      changes.push(`remove ${field}`)
    }
    // The same people, in the same order, each named only with parts the records hold.
    const authors: { family: string; given: string }[] = (fix.authors ?? []).map((a: any) => ({ family: String(a?.family ?? '').trim(), given: String(a?.given ?? '').trim() }))
    const people = Array.isArray(record.author) ? record.author as Record<string, unknown>[] : []
    const held = (part: string) => part.split(/\s+/).every((word) => names.has(nameKey(word))) || names.has(nameKey(part))
    if (authors.length && authors.length === people.length && authors.every((a) => a.family && held(a.family) && (!a.given || held(a.given)))
      && authors.some((a, i) => a.family !== people[i].family || a.given !== (people[i].given ?? ''))) {
      record.author = authors.map((a) => (a.given ? { family: a.family, given: a.given } : { family: a.family }))
      changes.push('set author')
    }
    if (!changes.length) continue
    work.csl = record
    work.corrected = [...(work.corrected ?? []), ...changes]
    corrected.add(n)
  }
  found.forEach((d, i) => { if (!corrected.has(i + 1)) left.push(strip(d)) })
  return corrected.size
}

/** A name part as the records are compared: its letters, without case or spacing. */
const nameKey = (part: string) => squash(part).toLowerCase()

/** Every name part the reference list and the paper's records hold: each family and given name, and each word of them, with every two words side by side. */
function namesHeld(printed: Record<string, unknown>[], works: Work[]): Set<string> {
  const held = new Set<string>()
  const add = (text: unknown) => {
    const name = nameKey(String(text ?? ''))
    if (!name) return
    held.add(name)
    const words = name.split(/\s+/)
    words.forEach((word, i) => { held.add(word); if (words[i + 1]) held.add(`${word} ${words[i + 1]}`) })
  }
  const people = (list: unknown) => (Array.isArray(list) ? list : []) as Record<string, unknown>[]
  for (const entry of printed) for (const p of people(entry.author)) { add(p.family); add(p.given); add(p.literal) }
  for (const work of works) {
    for (const p of people(work.csl?.author)) { add(p.family); add(p.given) }
    for (const name of work.authors ?? []) add(name)
  }
  return held
}
