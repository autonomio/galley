// The copyedit. Sections are drafted one at a time and revised by different steps, so once review is done the whole
// text is read once more, as a copyeditor reads it, for what no single section shows: a definition, count or quantity
// stated one way here and another there (a figure caption included), a statement a later passage contradicts, a
// symbol given two meanings or renamed partway, one thing under two names, a definition or a scope stated again where
// it was already made, a sentence cut off from what it refers to, a citation used as a noun, labels written two ways. A family other than the author's finds them; the author fixes each
// with exact edits to the section or caption it is in.
import type { Paper } from '../paper.js'
import { HOUSE } from '../prompts.js'
import { fillPlaceholders, productionRecord } from '../record.js'
import type { Behavior } from '../scheduler.js'
import { arr, obj, str } from '../schema.js'
import { applyExact } from '../text.js'
import { reviewDone } from './close.js'
import { live, seatFamily, sectionText } from './common.js'
import { storyTold } from './story.js'
import { setPassage } from './write.js'

export const copyedit: Behavior = {
  id: 'copyedit', stage: 'close', improver: true, title: 'Copyedit the whole text',
  // After the works the text names are cited, so it reads the text as it will print; before the ledger is reconciled
  // with it, so the ledger says what the copyedited text says.
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.outline || s.outcome || paper.isSettled('frame:final') || !reviewDone(paper)) return []
    if (!paper.isSettled('named:works') && !paper.config.off.includes('cite-named')) return []
    // It reads the text as told: after the story steps, so their changes are made consistent with the rest.
    if (!storyTold(paper)) return []
    return [{
      key: 'copyedit:text', label: 'the whole text, read once for consistency',
      run: async () => {
        const record = productionRecord(paper)
        const sections = s.outline!.sections
        // The figures in the order they print, so each caption carries the number the text refers to it by.
        const figures = sections.flatMap((sec) => s.figures.filter((f) => f.sectionId === sec.id && f.status === 'rendered'))
        const checker = seatFamily(paper, 'checker')
        const reply = await paper.ask<any>({
          behavior: 'copyedit', target: 'text', seat: 'checker', family: checker,
          prompt: `${HOUSE}

You are the copyeditor. The manuscript below was drafted section by section and revised by several hands. Read it once as a whole and report every place where it is inconsistent with itself or says a thing twice:
- a definition, quantity, count, unit or name stated one way in one place and another way elsewhere, a figure caption included (a caption that describes what the text defines differently; a count of one thing called a count of another);
- a statement that another passage contradicts (a definition, proposition or claim that a later passage states otherwise);
- a symbol given two meanings or used for two things, a symbol renamed partway through, or a symbol or term used before it is defined;
- one thing called by two names (a quantity, its unit, a measure, a method), or one name used for two things;
- a definition, explanation, example or fact stated again where it was already made, in the same words or in others: it stays where it belongs and is referred to elsewhere;
- a scope, assumption or condition repeated paragraph after paragraph once it has been stated for the section or the paper;
- an abbreviation not spelled out at its first use in the body (the abstract does not count);
- a figure or table not referred to in the section that discusses what it shows, or first referred to before one with a lower number;
- a sentence cut off from what it refers to ("this", "these" with nothing before it to refer to), or a one-sentence paragraph left stranded between others;
- a list with no sentence introducing it, or a list of the paper's contributions that leaves out what a whole section contributes;
- a citation in parentheses used as a noun ("summarized in (Author 2026)");
- numbered statements labelled two ways (some with their name inside the bold label, others outside it);
- an aside that explains a number or a choice away (rounding, what a pooled figure mixes) where the plain statement would do;
- a punctuation or spelling convention the text follows almost everywhere and breaks in a few places (the serial comma, one variety of English);
- one term written two ways without reason (capitalised in one place and not in another, hyphenated in one and not the other, two spellings).
Do not judge the science, the argument or the style beyond these; other steps did. For each problem give where (the ids in brackets of the sections and captions it concerns), quote (the words concerned, copied character for character from one of them), problem, and fix (what the text should say, the same everywhere it is said). If the text is consistent, return no problems.

${sections.map((sec) => `[${sec.id}] # ${sec.title}\n\n${fillPlaceholders(sectionText(paper, sec.id), record).text}`).join('\n\n')}
${figures.length ? `\nFIGURE CAPTIONS:\n${figures.map((f, i) => `[${f.id}] Figure ${i + 1}: ${fillPlaceholders(f.caption, record).text}`).join('\n')}\n` : ''}`,
          schema: obj({ problems: arr(obj({ where: arr(str()), quote: str(), problem: str(), fix: str() })) }),
        })
        const ids = new Set([...sections.map((sec) => sec.id), ...figures.map((f) => f.id)])
        const problems = (reply.problems ?? [])
          .map((p: any) => ({ where: (p.where ?? []).map((w: unknown) => String(w).replace(/[[\]]/g, '').trim()).filter((w: string) => ids.has(w)), quote: String(p.quote ?? ''), problem: String(p.problem ?? ''), fix: String(p.fix ?? '') }))
          .filter((p: { where: string[]; problem: string }) => p.where.length && p.problem)
        let changed = 0
        if (problems.length) {
          const involved = [...new Set(problems.flatMap((p: { where: string[] }) => p.where))] as string[]
          const author = seatFamily(paper, 'author')
          const answer = await paper.ask<any>({
            behavior: 'copyedit', target: 'fixes', seat: 'author', family: author,
            prompt: `${HOUSE}

The copyeditor found these inconsistencies in the manuscript. Fix each with exact edits: in is the id of the section or figure caption the edit is made in, old is copied character for character from its source below, and new replaces it; {{placeholders}} stay as they are where they belong. Where a problem names two places, make them agree on the reading the rest of the paper and its claims support. Where a thing is said twice, keep the one statement where it belongs and, elsewhere, refer to it or remove the repetition. Change nothing else, and add no hedge or caveat.

${problems.map((p: { where: string[]; quote: string; problem: string; fix: string }, i: number) => `${i + 1}. [${p.where.join(', ')}] "${p.quote}": ${p.problem} Fix: ${p.fix}`).join('\n')}

SOURCES:
${involved.map((id) => {
  const fig = figures.find((f) => f.id === id)
  return fig ? `[${id}] figure caption\n"""\n${fig.caption}\n"""` : `[${id}] # ${sections.find((sec) => sec.id === id)!.title}\n"""\n${sectionText(paper, id)}\n"""`
}).join('\n\n')}`,
            schema: obj({ edits: arr(obj({ in: str(), old: str(), new: str() })) }),
          })
          const by = { kind: 'agent' as const, family: author, model: paper.config.models[author]?.model ?? author, seat: 'author' as const, behavior: 'copyedit' }
          const texts = new Map<string, string>()
          for (const edit of answer.edits ?? []) {
            const id = String(edit.in ?? '').replace(/[[\]]/g, '').trim()
            if (!involved.includes(id)) continue
            const fig = figures.find((f) => f.id === id)
            const before = texts.get(id) ?? (fig ? fig.caption : sectionText(paper, id))
            const after = applyExact(before, edit)
            if (after !== null && after !== before) texts.set(id, after)
          }
          for (const [id, text] of texts) {
            const fig = figures.find((f) => f.id === id)
            if (fig) fig.caption = text
            else setPassage(paper, id, text, by, 'made consistent with the rest of the text')
            changed++
          }
        }
        paper.journal({ event: 'copyedit', problems: problems.length, changed })
        if (problems.length) paper.note('copyedit', `${problems.length} inconsistenc${problems.length === 1 ? 'y' : 'ies'} or repetition${problems.length === 1 ? '' : 's'} found across the text; ${changed} section${changed === 1 ? '' : 's'} or caption${changed === 1 ? '' : 's'} made consistent.`)
        paper.save()
      },
      // An improvement pass: if it cannot run, the text stands as reviewed and the proof reading still reads it.
      skip: () => {},
    }]
  },
}
