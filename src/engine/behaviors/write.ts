// From an outline with settled evidence to a manuscript: draft each section,
// check it against its claims, draw its figures, and write its frame.
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Paper } from '../paper.js'
import { HOUSE, placeholderGuide, STYLE } from '../prompts.js'
import type { Behavior, Target } from '../scheduler.js'
import { arr, enm, obj, str } from '../schema.js'
import { applyExact, dropUnknownCitations, words } from '../text.js'
import type { Passage, Section } from '../types.js'
import { activeClaims, briefBlock, citableKeys, claimsBlock, keyFor, live, manuscriptBlock, noteForAuthors, now, seatFamily, sectionText } from './common.js'
import { verifyCitationsSettled } from './truth.js'
import { literatureBlock, REVIEW_SECTION, REVIEW_SECTION_RULES } from '../literature.js'
import { simulationSeries } from '../simulations.js'
import { fillPlaceholders, productionRecord } from '../record.js'

const knownKeys = citableKeys

function figureNumbers(paper: Paper): Map<string, number> {
  const numbers = new Map<string, number>()
  let n = 0
  for (const section of paper.state.outline?.sections ?? []) {
    for (const fig of paper.state.figures.filter((f) => f.sectionId === section.id && f.status !== 'skipped')) numbers.set(fig.id, ++n)
  }
  return numbers
}

export function setPassage(paper: Paper, sectionId: string, text: string, by: Passage['revisions'][number]['by'], reason: string): void {
  const passage = paper.state.passages[sectionId] ?? { sectionId, text: '', revisions: [], checked: 'unchecked' as const }
  if (passage.text === text) return
  passage.text = text
  passage.revisions.push({ at: now(), text, by, reason })
  passage.checked = 'unchecked'
  paper.state.passages[sectionId] = passage
}

export const draft: Behavior = {
  id: 'draft', stage: 'skeleton', improver: false, title: 'Draft passage',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.outline) return []
    const evidenceOff = paper.config.off.includes('find-evidence')
    return s.outline.sections
      // The review section waits for Canary's findings; every other section, for its evidence.
      .filter((section) => !s.passages[section.id] && (section.id === REVIEW_SECTION ? s.literature?.status === 'done' : evidenceOff || verifyCitationsSettled(paper, section.claimIds)))
      .map((section): Target => ({
        key: `draft:${section.id}`, label: `${section.id} ${section.title}`,
        run: async () => {
          const family = seatFamily(paper, 'author')
          const numbers = figureNumbers(paper)
          const figures = s.figures.filter((f) => f.sectionId === section.id && f.status !== 'skipped')
          const reply = await paper.ask<any>({
            behavior: 'draft', target: section.id, seat: 'author', family,
            prompt: `${HOUSE}

${STYLE}

Write one section of the paper in Pandoc Markdown.

${briefBlock(paper)}
Venue: ${paper.config.venue}. Style for this venue and field: ${s.outline!.style}
Glossary: ${s.outline!.glossary.join('; ')}

The whole paper, so you know what the other sections cover:
${s.outline!.sections.map((sec) => `${sec.id} ${sec.title}: ${sec.purpose}`).join('\n')}

YOUR SECTION: ${section.id} ${section.title}
Purpose: ${section.purpose}
Length: about ${section.words} words.
${figures.length ? `Figures placed after this section's text, to refer to by number: ${figures.map((f) => `Figure ${numbers.get(f.id)}: ${f.caption}`).join('; ')}` : ''}

Claims this section establishes, with their evidence:
${claimsBlock(paper, section.claimIds) || '(none; this section connects and frames)'}

Rules:
- Every factual sentence states one of the claims above or connects them. Add no new factual claims, numbers or names.
- Cite only with the keys given above, in Pandoc form: [@key] or [@key1; @key2], or @key for a narrative citation. Cite a claim's evidence where the claim is made. Never cite a key that is not listed.
- A claim without verified evidence is stated plainly, like the paper's other claims, and gets a note for the authors saying it has no verified source.
- notes: everything the authors should know about this section that the text must not say: a claim with no verified source, a limit of the work, a doubt, a caution. Each note gives quote (the exact words of your section it concerns, copied character for character) and note (one or two sentences to the authors).
- Do not write the section heading. You may use ## subheadings if the section is long.
- Numbers about how this manuscript itself was produced may be written only as these placeholders, which are filled in from the production record at typesetting:
${placeholderGuide()}
${section.id === REVIEW_SECTION ? `\n${literatureBlock(paper)}\n\n${REVIEW_SECTION_RULES}\n` : ''}
Return markdown (the section body), used_claims (ids of the claims you stated) and notes.`,
            schema: obj({ markdown: str(), used_claims: arr(str()), notes: arr(obj({ quote: str(), note: str() })) }),
          })
          const { text, dropped } = dropUnknownCitations(String(reply.markdown ?? '').trim(), knownKeys(paper))
          if (dropped.length) paper.note('draft', `${section.id}: removed citations to unknown keys ${[...new Set(dropped)].join(', ')}`)
          setPassage(paper, section.id, text, { kind: 'agent', family, model: paper.config.models[family]?.model ?? family, seat: 'author', behavior: 'draft' }, 'first draft')
          // The caution the text leaves out goes beside it, for the authors.
          for (const n of reply.notes ?? []) noteForAuthors(paper, { sectionId: section.id, quote: text.includes(String(n.quote ?? '')) ? String(n.quote) : '', text: String(n.note ?? ''), kind: /source|evidence|verif|cit/i.test(String(n.note)) ? 'unverified' : 'caution', seat: 'author', family, behavior: 'draft' })
          // A claim the section states without a verified source is flagged for the authors even when the draft did not say so.
          for (const c of activeClaims(paper).filter((k) => section.claimIds.includes(k.id) && k.status === 'unsupported' && (reply.used_claims ?? []).includes(k.id))) {
            if (!(paper.state.authorNotes ?? []).some((n) => n.sectionId === section.id && n.kind === 'unverified' && n.text.includes(c.id))) noteForAuthors(paper, { sectionId: section.id, quote: '', text: `${c.id} has no verified source: "${c.text}" Cite a source for it, or cut it.`, kind: 'unverified', seat: 'author', family, behavior: 'draft' })
          }
          paper.save()
        },
      }))
  },
}

export const fidelity: Behavior = {
  id: 'fidelity', stage: 'truth', improver: true, title: 'Check fidelity',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.outline) return []
    return s.outline.sections
      .filter((section) => s.passages[section.id] && !s.passages[section.id].revisions.some((r) => r.reason.startsWith('fidelity')) && s.passages[section.id].checked === 'unchecked')
      .map((section): Target => ({
        key: `fidelity:${section.id}`, label: `${section.id} against its claims`,
        run: async () => {
          const family = seatFamily(paper, 'checker')
          const text = sectionText(paper, section.id)
          const reply = await paper.ask<any>({
            behavior: 'fidelity', target: section.id, seat: 'checker', family,
            prompt: `${HOUSE}

${STYLE}

Check one section of a manuscript against the claims and evidence it is allowed to state. Report each sentence that says more than its claim or passage supports (overclaim), states a fact that is not among the claims (unsupported), cites a key whose passage does not back the sentence (miscite), contradicts another claim (contradiction), or breaks the style rules (style). For each, give the exact text to replace (old, copied character for character from the section, long enough to be unique) and its replacement (new): the smallest change that makes the sentence faithful. Fix an overclaim by stating exactly what the evidence supports, plainly; never by adding a hedge (may, might, could, appears, suggests) or a caveat. When a citation is wrong, remove or replace its key; never write an author's name in its place. Placeholders like {{run.calls}} are filled in later and are allowed. Report nothing for sentences that are fine.

Section ${section.id} ${section.title} (purpose: ${section.purpose}):
"""
${text}
"""

Claims and evidence for this section:
${claimsBlock(paper, section.claimIds) || '(none)'}${section.id === REVIEW_SECTION || (paper.config.literatureReview === 'load-bearing' && paper.state.literature?.status === 'done') ? `\n\nThis section reports a systematic review. Each citation's passage is an excerpt of the full text the review read, and the review's independent audit checked every finding against those texts: report a miscite only when a passage is about something else or contradicts the sentence, not because the excerpt leaves out a detail the finding states. Besides its findings the section may state the review's method, disagreements and open questions as given here:\n${literatureBlock(paper)}` : ''}`,
            schema: obj({ issues: arr(obj({ problem: enm(['overclaim', 'unsupported', 'miscite', 'contradiction', 'style']), severity: enm(['minor', 'material']), old: str(), new: str() })) }),
          })
          let next = text
          let applied = 0
          let missed = 0
          for (const issue of reply.issues ?? []) {
            const changed = applyExact(next, issue)
            if (changed === null) { missed++; continue }
            next = changed
            applied++
          }
          const { text: clean } = dropUnknownCitations(next, knownKeys(paper))
          if (clean !== text) setPassage(paper, section.id, clean, { kind: 'agent', family, model: paper.config.models[family]?.model ?? family, seat: 'checker', behavior: 'fidelity' }, `fidelity: ${applied} fixes`)
          s.passages[section.id].checked = missed ? 'changes_requested' : 'faithful'
          if (missed) paper.journal({ event: 'fidelity_unanchored', section: section.id, count: missed })
          paper.save()
        },
      }))
  },
}

function typst(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile('typst', args, { cwd, timeout: 120_000 }, (error, _stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stderr)))
}

export const figure: Behavior = {
  id: 'figure', stage: 'substance', improver: true, title: 'Make figure',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.outline) return []
    return s.figures.filter((f) => f.status === 'planned').map((fig): Target => ({
      // A figure a reader sent back is drawn again as a step of its own: the first drawing's step is long settled.
      key: fig.redraws ? `figure:${fig.id}:redraw${fig.redraws}` : `figure:${fig.id}`, label: fig.id,
      run: async () => {
        const dir = paper.path('build', 'figures')
        mkdirSync(dir, { recursive: true })
        const lastError = paper.state.notes.filter((n) => n.behavior === `figure:${fig.id}`).pop()?.text
        // Drawn again after review, a figure follows the section as it now reads, so the two say the same.
        const sectionNow = paper.state.passages[fig.sectionId]?.text.slice(0, 9000) ?? ''
        const reply = await paper.ask<any>({
          behavior: 'figure', target: fig.id, seat: 'author', family: seatFamily(paper, 'author'),
          prompt: `${HOUSE}

Draw one figure for the paper as a standalone Typst document (Typst 0.15). Use only built-in Typst: rect, circle, ellipse, line, polygon, path, place, grid, stack, box, block, align, text, table, arrows drawn with line and polygon. Do not import packages. Design it at the size it will be printed, which is exactly the size you draw it: start with #set page(width: 14cm, height: auto, margin: 6pt) and #set text(font: "New Computer Modern", size: 9pt), keep every label at 8pt or larger, and keep the figure no wider than it is tall by more than about two to one, so it stays legible on a printed page; stack or wrap rows rather than running one long row. Keep it clean and legible in greyscale with one accent colour (rgb("#2b5797")). The figure must show only what the paper describes; no invented data. Print no internal identifier (no claim, dataset, scenario, simulation, plan or section id such as C12, D1, S2 or P3): name each thing as the text names it. Put no citation or author–year reference inside the figure; the caption and the text cite.

${briefBlock(paper)}
Figure: ${fig.caption}
Specification: ${fig.spec}
Section it illustrates: ${paper.state.outline!.sections.find((sec) => sec.id === fig.sectionId)?.title}
Relevant claims:
${claimsBlock(paper, paper.state.outline!.sections.find((sec) => sec.id === fig.sectionId)?.claimIds ?? [])}
${sectionNow ? `\nThe section as it now reads; the figure and its caption must agree with it (its counts, categories, statuses and wording):\n"""\n${sectionNow}\n"""\n` : ''}${simulationSeries(paper) ? `\n${simulationSeries(paper)}\nChart a simulation only from these values, and label the axes with the quantities and units the paper uses.` : ''}
${lastError ? `\nThe previous attempt failed to compile with: ${lastError}\nFix that.` : ''}${fig.revise ? `\nIn the typeset paper, a reader found this in the figure: ${fig.revise}\nDraw it again without that defect.` : ''}
A number may be written as its {{placeholder}}; it is filled in with its recorded value before the figure is drawn.

Return typst (the complete document source), and caption: the caption as it should print under the figure. Keep the current caption unless it no longer matches the figure as drawn or the section as it reads; never name an internal identifier in it, and write any mathematics in it in LaTeX between dollar signs ($W_t$, not W_t).`,
          schema: obj({ typst: str(), caption: str() }),
        })
        // A figure is a picture: its numbers are written in before it is drawn, never left as placeholders. No label is
        // set smaller than 8pt, whatever the drawing asked for, so it stays legible at the size it is printed.
        const source = fillPlaceholders(String(reply.typst ?? ''), productionRecord(paper)).text
          .replace(/size:\s*(\d+(?:\.\d+)?)pt/g, (setting: string, size: string) => Number(size) < 8 ? 'size: 8pt' : setting)
        writeFileSync(`${dir}/${fig.id}.typ`, source)
        try {
          await typst(['compile', `${fig.id}.typ`, `${fig.id}.png`, '--ppi', '250'], dir)
        } catch (error) {
          const message = (error as Error).message.slice(0, 600)
          paper.state.notes.push({ at: now(), behavior: `figure:${fig.id}`, text: message })
          paper.save()
          throw new Error(`figure ${fig.id} did not compile: ${message}`)
        }
        fig.status = 'rendered'
        fig.file = `figures/${fig.id}.png`
        fig.source = source
        if (String(reply.caption ?? '').trim()) fig.caption = String(reply.caption).trim()
        delete fig.revise
        paper.save()
      },
      skip: () => { fig.status = 'skipped' },
    }))
  },
}

function fidelityDone(paper: Paper, section: Section): boolean {
  return paper.config.off.includes('fidelity') || paper.isSettled(`fidelity:${section.id}`)
}

/** The run goes on after the frame is written, so its numbers are placeholders, filled in wherever the paper is shown. */
export const FRAME_NUMBERS = 'Write any number about this manuscript\'s own production as its placeholder from the list below (for example {{run.hours}}), never as a figure: the run is still going, and placeholders are filled in when the paper is typeset.'

export const frame: Behavior = {
  id: 'frame', stage: 'manuscript', improver: false, title: 'Write frame',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.outline || s.frame) return []
    if (!s.outline.sections.every((sec) => s.passages[sec.id] && fidelityDone(paper, sec))) return []
    if (s.figures.some((f) => f.status === 'planned' && !paper.config.off.includes('figure'))) return []
    return [{
      key: 'frame:paper', label: 'title, abstract and keywords',
      run: async () => {
        const reply = await paper.ask<any>({
          behavior: 'frame', target: 'paper', seat: 'author', family: seatFamily(paper, 'author'),
          prompt: `${HOUSE}

${STYLE}

Write the frame of this manuscript.
- title: at most 15 words, specific, carrying the paper's noun if it has one; no colon-subtitle unless the field expects it.
- abstract: 150 to 250 words, one paragraph, no citations: the problem, what the paper contributes, how the contribution is supported, and what it opens. State only what the manuscript states. ${FRAME_NUMBERS}
- keywords: 5 to 7.

${placeholderGuide()}

${briefBlock(paper)}

MANUSCRIPT:
${manuscriptBlock(paper, false)}`,
          schema: obj({ title: str(), abstract: str(), keywords: arr(str()) }),
        })
        s.frame = { title: reply.title, abstract: reply.abstract, keywords: reply.keywords ?? [], limitations: '', opens: '' }
        paper.save()
      },
    }]
  },
}

export const manuscriptWords = (paper: Paper) => Object.values(paper.state.passages).reduce((n, p) => n + words(p.text), 0)
