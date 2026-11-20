// The typeset review: nothing that must never be printed reaches a page, and a
// defect a reader finds goes back to whoever can fix it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { calledOut, printedDefects, proof } from '../../src/engine/behaviors/proof.js'
import { figure } from '../../src/engine/behaviors/write.js'
import { Paper } from '../../src/engine/paper.js'
import { contentHash, numberEquations, printedQuotes } from '../../src/engine/render.js'
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

  it('draws again a figure an earlier engine sent back under its settled first step, so the paper can finish', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    paper.state.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: ['F1'] }], style: '', glossary: [] }
    paper.state.figures = [{ id: 'F1', caption: 'c', spec: '', sectionId: 'S1', status: 'planned', revise: 'A label overlaps the axis.' }]
    paper.settle('figure:F1', 'done')
    expect(figure.ready(Paper.open(paper.dir)).map((t) => t.key)).toEqual(['figure:F1:redraw1'])
  })
})
