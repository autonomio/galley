// The typeset review: nothing that must never be printed reaches a page, and a
// defect a reader finds goes back to whoever can fix it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { calledOut, printedDefects, printedTables, proof } from '../../src/engine/behaviors/proof.js'
import { figure } from '../../src/engine/behaviors/write.js'
import { Paper } from '../../src/engine/paper.js'
import { columnShares, contentHash, fitTables, numberEquations, printedQuotes, splitWideEquations } from '../../src/engine/render.js'
import { ledgerAppendix } from '../../src/engine/behaviors/common.js'
import { readableReason } from '../../src/engine/literature.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('what must never be printed', () => {
  it('finds placeholders, raw labels, unresolved references and blanks, and nothing in clean text', () => {
    const found = printedDefects('The rate is {{data.A5}} ms, see {#eq:budget} and @fig:trace. Funding: to be declared by the author. Value [not recorded].')
    expect(found.map((d) => d.problem)).toEqual(['an unfilled placeholder', 'a raw cross-reference label', 'an unresolved cross-reference', 'a number the production record does not hold', 'a blank left for the author to fill'])
    expect(printedDefects('The rate is 197 ms (Equation 2).')).toEqual([])
  })

  it('prints single quotes as the curly ones they are, outside math and code, and claim kinds as words', () => {
    expect(printedQuotes("Wei et al.'s and RSR++'s 'scare' quotes, Wang's view, $f'(x)$ and `a'b`."))
      .toBe("Wei et al.’s and RSR++’s ‘scare’ quotes, Wang’s view, $f'(x)$ and `a'b`.")
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    paper.state.claims = [{ id: 'C1', kind: 'common_knowledge', status: 'assumed', text: 'Gradients flow backwards.' } as Paper['state']['claims'][number]]
    expect(ledgerAppendix(paper)).toContain('**C1** (common knowledge;')
    // A review reason whose spaces were lost gives way to the one the selection gave for the same publication.
    const bundle = { research: { paper_selection: { selection: { decisions: [{ work_id: 'W1', reason: 'Domestic storage FCR ICT architecture.' }] } } } }
    expect(readableReason('FCRICTarchitectureanddelayinjections;storage', 'W1', bundle)).toBe('Domestic storage FCR ICT architecture.')
    expect(readableReason('Measured hybrid hydro tracking.', 'W1', bundle)).toBe('Measured hybrid hydro tracking.')
  })

  it('numbers display equations and turns their labels into those numbers', () => {
    const [a, b] = numberEquations(['$$\nL = a + b\n$$ {#eq:sum}\n\nThen $$x$$', 'By @eq:sum and [@eq:sum], it holds.'])
    expect(a).toBe('$$\nL = a + b\n$$\n\nThen $$x$$')
    expect(b).toBe('By (1) and (1), it holds.')
  })

  it('prints a negative number with a minus sign, and leaves ranges, dates, names and mathematics alone', () => {
    expect(printedQuotes('Shifts of -0.005 and (-3%), pages 1-29 on 2026-11-21, GPT-6.2, $x - 1$ and `a -1`.'))
      .toBe('Shifts of −0.005 and (−3%), pages 1-29 on 2026-11-21, GPT-6.2, $x - 1$ and `a -1`.')
  })

  it('gives a table\'s columns the width their cells take, and lets only a table too tall for a page break', () => {
    const notation = '| Symbol | Meaning |\n|:--|:--|\n| $b$ | gate basis, $b \\in \\{\\mathrm{AIG}, \\mathrm{XAG}\\}$ |\n| $c(T)$ | basis contrast, the difference between the MIG and XAG floors of a task |\n\nTable: Notation.'
    const fitted = fitTables(notation).split('\n')
    const [symbol, meaning] = fitted[1].split('|').slice(1, 3).map((rule) => rule.replace(/:/g, '').length)
    expect(fitted[1]).toMatch(/^\|:-+\|:-+\|$/)
    expect(meaning).toBeGreaterThan(symbol * 4)
    expect(fitted.join('\n')).not.toContain('{=typst}')
    const tall = `| Study | Finding |\n|---|---|\n${Array.from({ length: 40 }, (_, i) => `| S${i} | ${'a finding that wraps onto a second line of its cell '.repeat(2)} |`).join('\n')}\n\n: Included studies.\n\nNext paragraph.`
    const broken = fitTables(tall)
    expect(broken.startsWith('```{=typst}\n#[\n#show figure: set figure(placement: none)\n#show figure: set block(breakable: true)\n```')).toBe(true)
    // The caption stays inside, with the table it belongs to.
    expect(broken).toMatch(/: Included studies\.\n\n```\{=typst\}\n\]\n```\n\nNext paragraph\.$/)
  })

  it('lets narrow columns keep the room they need and shares the rest evenly among the wide ones', () => {
    // A symbol, a meaning of up to 46 characters, a unit of 29 and a distribution of 30: too much for one line.
    const [symbol, meaning, unit, value] = columnShares([6, 46, 29, 30])
    expect(symbol).toBeCloseTo(9 / 95, 5)
    expect(meaning).toBeCloseTo(unit, 5)
    expect(value).toBeCloseTo(unit, 5)
    expect(symbol + meaning + unit + value).toBeCloseTo(1, 5)
    // Columns that all fit take the width in proportion to what they hold.
    const [a, b] = columnShares([10, 30])
    expect(b / a).toBeCloseTo(33 / 13, 5)
  })

  it('sets two formulas side by side that print wider than the column one above the other, aligned, under one number', () => {
    const wide = '$$\n\\mathrm{floor}_{\\mathrm{XAG}}(T_i) = g_i + \\log_2\\bigl(1 + (r_{m,\\mathrm{XAG}} - 1)m_i\\bigr), \\qquad\n\\mathrm{floor}_{\\mathrm{MIG}}(T_i) = g_i + \\log_2\\bigl(1 + (r_{x,\\mathrm{MIG}} - 1)x_i\\bigr).\n$$'
    expect(splitWideEquations(wide)).toBe('$$\n\\begin{aligned}\n\\mathrm{floor}_{\\mathrm{XAG}}(T_i) &= g_i + \\log_2\\bigl(1 + (r_{m,\\mathrm{XAG}} - 1)m_i\\bigr), \\\\\n\\mathrm{floor}_{\\mathrm{MIG}}(T_i) &= g_i + \\log_2\\bigl(1 + (r_{x,\\mathrm{MIG}} - 1)x_i\\bigr).\n\\end{aligned}\n$$')
    // One that fits, and a condition after the spacing, stay as written.
    expect(splitWideEquations('$$E(T) = a, \\qquad S(T) = b.$$')).toBe('$$E(T) = a, \\qquad S(T) = b.$$')
    const condition = '$$\\sum_{i=1}^{n} \\mathrm{cost}_\\mu(A_i) + \\lambda\\, Q(A) + \\beta_\\times(w) + \\beta_+(w\') + \\mathrm{floor}_b(T) \\qquad \\text{for every task } T\\text{ and basis } b$$'
    expect(splitWideEquations(condition)).toBe(condition)
  })

  it('finds the tables the sections print, with their captions, and whether the text refers to each', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    paper.state.outline = { sections: [{ id: 'S1', title: 'A', purpose: '', claimIds: [], words: 1, figureIds: [] }, { id: 'S2', title: 'B', purpose: '', claimIds: [], words: 1, figureIds: [] }], style: '', glossary: [] }
    paper.state.passages = {
      S1: { sectionId: 'S1', text: 'Text.\n\n| a | b |\n|:--|:--|\n| 1 | 2 |\n\nTable: Notation.', revisions: [], checked: 'faithful' },
      S2: { sectionId: 'S2', text: 'Table: Costs.\n\n| c | d |\n|---|---|\n| 3 | 4 |\n\nAs Table 2 shows.', revisions: [], checked: 'faithful' },
    }
    expect(printedTables(paper)).toEqual([{ sectionId: 'S1', caption: 'Notation.' }, { sectionId: 'S2', caption: 'Costs.' }])
    expect([calledOut('As Table 2 shows.', 1, 'table'), calledOut('As Table 2 shows.', 2, 'table'), calledOut('as Figure 2 shows', 2, 'table')]).toEqual([false, true, false])
  })
})

describe('the typeset review', () => {
  it('sends a defect in the prose to the author and a figure with a placeholder back to be drawn again', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const s = paper.state
    s.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: ['F1'] }], style: '', glossary: [] }
    s.passages = { S1: { sectionId: 'S1', text: 'The switch takes 422 ms, as Figure ?? shows.', revisions: [], checked: 'faithful' } }
    s.figures = [{ id: 'F1', caption: 'Switchover percentiles against the tiers.', spec: '', sectionId: 'S1', status: 'rendered', file: 'figures/F1.png', source: '#text[p99 {{data.A5}} ms]' }]
    s.frame = { title: 'T', abstract: 'A', keywords: [], limitations: '', opens: '' }
    s.round = paper.config.rounds
    paper.settle('frame:final', 'done')
    paper.settle(`typeset:${contentHash(paper)}`, 'done')

    const asked: string[] = []
    paper.ask = (async (options: { seat: string }) => {
      asked.push(options.seat)
      return options.seat === 'checker'
        ? { defects: [{ page: 2, where: 'section text', quote: 'as Figure ?? shows', problem: 'The figure reference did not resolve.', fix: 'Name the figure.', fix_in: 'prose' }] }
        : { edits: [{ old: 'as Figure ?? shows', new: 'as Figure 1 shows' }] }
    }) as Paper['ask']
    await proof.ready(paper)[0].run()

    expect(asked).toEqual(['checker', 'author'])
    expect(s.passages.S1.text).toBe('The switch takes 422 ms, as Figure 1 shows.')
    expect(s.figures[0]).toMatchObject({ status: 'planned' })
    expect(s.figures[0].revise).toContain('an unfilled placeholder')
    // The unresolved reference also leaves Figure 1 with no callout; the check finds that too, and the author's one call fixes both.
    expect(s.proof).toMatchObject({ rounds: 1, fixed: 3, left: [] })
    expect(calledOut('as Figures 1–3 show, and Fig. 5', 2) && calledOut('see Figure 4', 4) && !calledOut('Figure 14', 1)).toBe(true)
    // The first drawing's step is settled, so drawing it again is a step of its own, and the new drawing a new revision.
    expect(figure.ready(paper).map((t) => t.key)).toEqual(['figure:F1:redraw1'])
    const before = contentHash(paper)
    Object.assign(s.figures[0], { status: 'rendered', source: '#text[p99 422 ms]' })
    const redrawn = contentHash(paper)
    Object.assign(s.figures[0], { source: '#text[p99 {{data.A5}} ms]' })
    expect(new Set([before, redrawn, contentHash(paper)]).size).toBe(3)
  })

  it('sends back every figure a reader names by its printed number, and tells the author the figures as printed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const s = paper.state
    s.outline = { sections: [{ id: 'S1', title: 'Model', purpose: '', claimIds: [], words: 300, figureIds: ['F1'] }, { id: 'S2', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: ['F2'] }], style: '', glossary: [] }
    s.passages = {
      S1: { sectionId: 'S1', text: 'Figure 1 shows the model, and Figure 2 its results.', revisions: [], checked: 'faithful' },
      S2: { sectionId: 'S2', text: 'The frequencies are in the figure below.', revisions: [], checked: 'faithful' },
    }
    s.figures = [
      { id: 'F1', caption: 'The model.', spec: '', sectionId: 'S1', status: 'rendered', file: 'figures/F1.png', source: '#text[model]' },
      { id: 'F2', caption: 'The frequencies.', spec: '', sectionId: 'S2', status: 'rendered', file: 'figures/F2.png', source: '#text[frequencies]' },
    ]
    s.frame = { title: 'T', abstract: 'A', keywords: [], limitations: '', opens: '' }
    s.round = paper.config.rounds
    paper.settle('frame:final', 'done')
    paper.settle(`typeset:${contentHash(paper)}`, 'done')
    const asks: { seat: string; prompt: string }[] = []
    paper.ask = (async (options: { seat: string; prompt: string }) => {
      asks.push(options)
      return options.seat === 'checker'
        ? { defects: [
          { page: 3, where: 'figure', quote: 'Figure 1', problem: 'A label overlaps the axis.', fix: 'Move the label.', fix_in: 'figure' },
          { page: 5, where: 'figure', quote: 'Figure 2', problem: 'The pooled bar is labelled differently from the caption.', fix: 'Label it as the caption does.', fix_in: 'figure' },
          { page: 5, where: 'figure', quote: 'Figure 2', problem: 'The results section never calls out Figure 2.', fix: 'Refer to it there.', fix_in: 'prose' },
        ] }
        : { edits: [{ old: 'in the figure below', new: 'in Figure 2' }] }
    }) as Paper['ask']
    await proof.ready(paper)[0].run()

    // Sending Figure 1 back does not renumber Figure 2 for the defects after it.
    expect(s.figures.map((f) => [f.id, f.status, f.redraws])).toEqual([['F1', 'planned', 1], ['F2', 'planned', 1]])
    // The missing callout goes to the figure's own section, not to the one that happens to print its number, and that
    // section's author is told the figures as the paper printed them.
    expect(asks.filter((a) => a.seat === 'author')).toHaveLength(1)
    expect(asks[1].prompt).toContain('section S2 Results')
    expect(asks[1].prompt).toContain('Figure 1: The model.\nFigure 2: The frequencies.')
    expect(s.passages.S2.text).toBe('The frequencies are in Figure 2.')
  })

  it('corrects a reference entry in its record, and never with a value the record does not hold', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const s = paper.state
    s.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: [] }], style: '', glossary: [] }
    s.passages = { S1: { sectionId: 'S1', text: 'Resource bounds can guide synthesis.', revisions: [], checked: 'faithful' } }
    s.works = { W1: { id: 'W1', doi: '10.1007/x', title: 'Synthesis with Asymptotic Resource Bounds', authors: ['Qinheping Hu'], year: 2021, venue: null, abstract: '', citedBy: null, url: null, bibKey: 'hu2021synthesis', csl: { type: 'book-chapter', 'container-title': ['Lecture Notes in Computer Science', 'Computer Aided Verification'], page: '783-807', abstract: 'Volume 12759 of the series.' } } }
    s.frame = { title: 'T', abstract: 'A', keywords: [], limitations: '', opens: '' }
    s.round = paper.config.rounds
    paper.settle('frame:final', 'done')
    const before = contentHash(paper)
    paper.settle(`typeset:${before}`, 'done')
    mkdirSync(paper.path('build'), { recursive: true })
    writeFileSync(paper.path('build', 'refs.json'), JSON.stringify([{ id: 'hu2021synthesis', type: 'chapter', title: 'Synthesis with Asymptotic Resource Bounds', 'container-title': 'Lecture Notes in Computer Science', page: '783-807' }]))
    const seats: string[] = []
    paper.ask = (async (options: { seat: string }) => {
      seats.push(options.seat)
      return options.seat === 'checker'
        ? { defects: [{ page: 9, where: 'references', quote: 'In Lecture Notes in Computer Science', problem: 'The Hu et al. entry names the series in place of the book.', fix: 'Name the book.', fix_in: 'other' }] }
        : { corrections: [{ defect: 1, id: 'hu2021synthesis', set: [{ field: 'container-title', value: 'Computer Aided Verification' }, { field: 'collection-title', value: 'Lecture Notes in Computer Science' }, { field: 'volume', value: '12759' }], remove: [] }] }
    }) as Paper['ask']
    await proof.ready(paper)[0].run()

    expect(seats).toEqual(['checker', 'author'])
    expect(s.works.W1.csl).toMatchObject({ 'container-title': 'Computer Aided Verification', 'collection-title': 'Lecture Notes in Computer Science' })
    // The volume is in neither the record's bibliographic fields nor the printed entry, so it is not set.
    expect(s.works.W1.csl!.volume).toBeUndefined()
    expect(s.works.W1.corrected).toEqual(['set container-title', 'set collection-title'])
    expect(s.proof).toMatchObject({ fixed: 1, left: [] })
    // The corrected entry is a new revision, typeset and read again.
    expect(contentHash(paper)).not.toBe(before)
  })

  it('draws again a figure an earlier engine sent back under its settled first step, so the paper can finish', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    paper.state.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: ['F1'] }], style: '', glossary: [] }
    paper.state.figures = [{ id: 'F1', caption: 'c', spec: '', sectionId: 'S1', status: 'planned', revise: 'A label overlaps the axis.' }]
    paper.settle('figure:F1', 'done')
    expect(figure.ready(Paper.open(paper.dir)).map((t) => t.key)).toEqual(['figure:F1:redraw1'])
  })
})
