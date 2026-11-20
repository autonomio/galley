// The typeset review: nothing that must never be printed reaches a page, and a
// defect a reader finds goes back to whoever can fix it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { printedDefects, proof } from '../../src/engine/behaviors/proof.js'
import { Paper } from '../../src/engine/paper.js'
import { contentHash, numberEquations } from '../../src/engine/render.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('what must never be printed', () => {
  it('finds placeholders, raw labels, unresolved references and blanks, and nothing in clean text', () => {
    const found = printedDefects('The rate is {{data.A5}} ms, see {#eq:budget} and @fig:trace. Funding: to be declared by the author. Value [not recorded].')
    expect(found.map((d) => d.problem)).toEqual(['an unfilled placeholder', 'a raw cross-reference label', 'an unresolved cross-reference', 'a number the production record does not hold', 'a blank left for the author to fill'])
    expect(printedDefects('The rate is 197 ms (Equation 2).')).toEqual([])
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
    expect(s.proof).toMatchObject({ rounds: 1, fixed: 2, left: [] })
  })
})
