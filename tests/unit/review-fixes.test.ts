// What telco run 4's review asked of the engine: charts keep their data through a retry, a run label never overwrites
// a column, references print clean, the verifier's controls are its own, sections are named by the numbers they print
// with, and the data appendix names its tables.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { calibrationItems } from '../../src/engine/behaviors/close.js'
import { printedNumber } from '../../src/engine/behaviors/common.js'
import { keepData } from '../../src/engine/behaviors/story.js'
import { groupOf } from '../../src/engine/charts.js'
import { cleanCsl } from '../../src/engine/evidence.js'
import { addDatasets, describeData } from '../../src/engine/materials.js'
import { Paper } from '../../src/engine/paper.js'
import type { ChartPanel, Citation } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const panel = (data: string[], labels: string[], unit = 'EUR'): ChartPanel => ({ kind: 'hist', data, labels, x: 'Profit', y: 'Draws', unit, marks: [] })

describe('what the last review asked of the engine', () => {
  it('keeps a chart\'s data, labels and units through a retry that reorders or rescales them', () => {
    const original = [panel(['sim:S1:profit', 'sim:S2:profit'], ['Base', 'Stress'])]
    const revised = [panel(['sim:S2:profit', 'sim:S1:profit'], ['Stress case', 'Base case'], 'kEUR')]
    expect(keepData(original, revised)).toEqual([expect.objectContaining({ data: ['sim:S1:profit', 'sim:S2:profit'], labels: ['Base case', 'Stress case'], unit: 'EUR' })])
  })

  it('keeps each revised design with the matching panel kind when panels share references', () => {
    const data = ['sim:S1:profit', 'sim:S2:profit']
    const original: ChartPanel[] = [panel(data, ['A', 'B']), { ...panel(data, ['A', 'B']), kind: 'interval' }]
    const revised: ChartPanel[] = [
      { ...panel(data, ['A', 'B']), kind: 'interval', x: 'Interval x', marks: [{ axis: 'x', value: 1, label: 'interval' }] },
      { ...panel(data, ['A', 'B']), x: 'Histogram x', marks: [{ axis: 'x', value: 2, label: 'histogram' }] },
    ]
    expect(keepData(original, revised).map((p) => [p.kind, p.x, p.marks[0].label])).toEqual([
      ['hist', 'Histogram x', 'histogram'], ['interval', 'Interval x', 'interval'],
    ])
  })

  it('does not give an unmatched panel a revision belonging to another panel', () => {
    const original = [panel(['A'], ['Original A']), panel(['B'], ['Original B'])]
    const revised = [panel(['B'], ['Revised B']), panel(['C'], ['Revised C'])]
    const result = keepData(original, revised)
    expect(result[0]).toEqual(original[0])
    expect(result[1]).toMatchObject({ data: ['B'], labels: ['Revised B'] })
  })

  it('never puts the run labels under a column the rows already use', () => {
    expect(groupOf({ ...panel([], []), group: 'Value' })).toBe('Run')
    expect(groupOf({ ...panel([], []), group: 'Mean' })).toBe('Run')
    expect(groupOf({ ...panel([], []), group: 'Allowance' })).toBe('Allowance')
  })

  it('prints a registry\'s capitalized names as names, and a title without its markup breaks or footnote mark', () => {
    const csl = cleanCsl({ type: 'article-journal', title: 'Measurement of Both\n        ICT\n        Response Times\n        †', author: [{ family: 'ZIRAS', given: 'Charalampos' }, { family: 'Imanaka', given: 'J. R.' }] })
    expect(csl.title).toBe('Measurement of Both ICT Response Times')
    expect(csl.author).toEqual([{ family: 'Ziras', given: 'Charalampos' }, { family: 'Imanaka', given: 'J. R.' }])
  })

  it('draws the verifier\'s unaltered controls only from the citations it was given for them', () => {
    const cite = (id: string, claimId: string, workId: string) => ({ id, claimId, workId, passage: `passage ${id}`, role: 'support', status: 'verified', chosenBy: 'auto' }) as Citation
    const all = [cite('K1', 'C1', 'W1'), cite('K2', 'C2', 'W2')]
    expect(calibrationItems(all, (id) => `Claim ${id}.`, []).some((item) => item.kind === 'control')).toBe(false)
    expect(calibrationItems(all, (id) => `Claim ${id}.`, [all[1]]).filter((item) => item.kind === 'control').map((item) => item.cite.id)).toEqual(['K2', 'K2'])
  })

  it('names a section by the number it prints with, and the data appendix by its tables\' numbers', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const file = join(dir, 'trees.csv')
    writeFileSync(file, `id,height\n${Array.from({ length: 20 }, (_, i) => `${i},${10 + i}`).join('\n')}\n`)
    const { materials, datasets } = await addDatasets(join(dir, 'p'), [{ name: 'Trees', files: [file], producedBy: 'others' }])
    const paper = Paper.create(join(dir, 'p'), 'seed', { materials, datasets })
    paper.state.outline = { sections: [
      { id: 'S1', title: 'Introduction' }, { id: 'LR', title: 'Literature Review' }, { id: 'S2', title: 'Methods' }, { id: 'SL', title: 'Limitations', role: 'limitations' },
    ] } as Paper['state']['outline']
    expect([printedNumber(paper, 'S2'), printedNumber(paper, 'LR'), printedNumber(paper, 'SL')]).toEqual([3, 2, null])
    expect(describeData(paper, 4)).toMatch(/^Table 4 describes the dataset as it was analysed/)
  })
})
