// The story: the reviewed research is told without changing it. Its caveats gather in one Limitations section that
// prints after the conclusion without a number; a worked number must be what its arithmetic gives; a change that
// loses what the research rests on, or that another family judges changed the research, is undone; and a chart draws
// only the paper's own records.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyedit } from '../../src/engine/behaviors/copyedit.js'
import { proof } from '../../src/engine/behaviors/proof.js'
import { STORY_STEPS, checkCalculation, renumber, researchLost, storyCaveats, storyCharts, storyExample, storyRead, storyReadDone, storyTold, writtenNumber } from '../../src/engine/behaviors/story.js'
import { fidelity } from '../../src/engine/behaviors/write.js'
import { chartCatalog, drawChart, panelRows, toCsv } from '../../src/engine/charts.js'
import { Paper } from '../../src/engine/paper.js'
import { buildManuscript, contentHash } from '../../src/engine/render.js'
import { simulate } from '../../src/engine/simulation/index.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

/** A reviewed paper whose works are cited: the story may begin. */
function reviewed(): Paper {
  dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
  const paper = Paper.create(join(dir, 'p'), 'seed')
  const s = paper.state
  s.outline = { sections: [
    { id: 'S1', title: 'Introduction', purpose: '', claimIds: [], words: 300, figureIds: [] },
    { id: 'S2', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: [] },
    { id: 'S3', title: 'Conclusion', purpose: '', claimIds: [], words: 100, figureIds: [] },
  ], style: '', glossary: [] }
  s.passages = {
    S1: { sectionId: 'S1', text: 'Scaling curves describe what compute buys [@kaplan2020].', revisions: [], checked: 'faithful' },
    S2: { sectionId: 'S2', text: 'Search costs exceed execution costs in every draw. The cost model is not validated against measured training runs, so these are modeled costs.', revisions: [], checked: 'faithful' },
    S3: { sectionId: 'S3', text: 'Search dominates.', revisions: [], checked: 'faithful' },
  }
  s.frame = { title: 'Search Bloat and Execution Bloat as a Floor-Referenced Yardstick', abstract: 'A', keywords: [], limitations: '', opens: '' }
  s.round = paper.config.rounds
  paper.settle('named:works', 'done')
  return paper
}

describe('telling the research', () => {
  it('keeps what the research rests on, wherever it moves', () => {
    const record = { 'sim.S1.x.p50': '5.04' }
    const before = new Map([['S1', 'Dense training sits {{sim.S1.x.p50}} above the floor [@kaplan2020].'], ['S2', '**Proposition 1 (Floor).** It holds.\n\n| a | b |\n|---|---|\n| 1 | 2 |']])
    // A number and a citation moved to another section are kept; the only statement of either, removed, is not.
    const moved = new Map([['S1', 'Dense training sits above the floor.'], ['S2', `${before.get('S2')} It is {{sim.S1.x.p50}} [@kaplan2020].`]])
    expect(researchLost(before, moved, record).size).toBe(0)
    const lost = researchLost(before, new Map([['S1', 'Dense training sits above the floor.'], ['S2', 'It holds. {{sim.S9.y}} [@new2026]']]), record)
    expect(lost.get('S1')).toEqual(["it removes the paper's only citation of @kaplan2020", "it removes the paper's only statement of {{sim.S1.x.p50}}"])
    expect(lost.get('S2')).toEqual(expect.arrayContaining(['it cites @new2026, which the paper did not cite', '{{sim.S9.y}} is not a recorded number', 'Proposition 1 is gone', 'it removes a table']))
  })

  it('checks every worked number against its arithmetic', () => {
    const record = { 'sim.S1.x.p50': '5.042' }
    expect(checkCalculation('2 + 4 * 10', '42', record)).toBeNull()
    expect(checkCalculation('50 * 52 * 51 / 2', '66,300', record)).toBeNull()
    expect(checkCalculation('log10(66300 / 42)', '3.198', record)).toBeNull()
    expect(checkCalculation('{{sim.S1.x.p50}} - 3', '2.042', record)).toBeNull()
    expect(checkCalculation('2 + 4 * 10', '44', record)).toMatch(/gives 42, not 44/)
    expect(checkCalculation('{{sim.S9.y}} * 2', '3', record)).toMatch(/not a recorded number/)
    expect(writtenNumber('1.2 × 10^5')?.value).toBe(120000)
    expect(writtenNumber('$1.2 \\times 10^{5}$')?.value).toBe(120000)
    // A written 66,300 may round 66,312; a written 100 does not stand for 149.
    expect(writtenNumber('66,300')?.tolerance).toBe(50)
    expect(writtenNumber('100')?.tolerance).toBe(0.5)
  })

  it('renumbers the figures a text refers to when a chart is placed before them', () => {
    expect(renumber('Figure 2 and Figures 3 and 4 show it; see Figure 1.', new Map([[1, 1], [2, 3], [3, 4], [4, 5]])))
      .toBe('Figure 3 and Figures 4 and 5 show it; see Figure 1.')
  })

  it('gathers the caveats into a Limitations section printed after the conclusion, and holds the copyedit until the paper is told', async () => {
    const paper = reviewed()
    const s = paper.state
    s.authorNotes = [{ id: 'N1', sectionId: 'S2', quote: '', text: 'The referee noted that only one task family is calibrated.', kind: 'limitation', seat: 'referee' as never, family: 'gpt', behavior: 'respond', at: '' }]
    expect(storyCaveats.ready(paper).map((t) => t.key)).toEqual(['story:caveats'])
    expect(copyedit.ready(paper)).toEqual([])
    let asked = 0
    paper.ask = (async (options: { seat: string; target: string }) => {
      if (options.seat === 'checker') return { parts: [{ id: 'S2', verdict: 'kept', what: '' }, { id: 'SL', verdict: 'kept', what: '' }] }
      asked++
      // A limit worded as a remark on how the paper was made goes back once.
      return {
        edits: [{ in: 'S2', old: ' The cost model is not validated against measured training runs, so these are modeled costs.', new: '' }],
        limitations: asked === 1
          ? 'No person independently reviewed the cost model.'
          : 'The costs are modeled, not measured: the cost model has not been compared with instrumented training runs. Only one task family, sparse parity, is calibrated.',
      }
    }) as Paper['ask']
    await storyCaveats.ready(paper)[0].run()
    expect(asked).toBe(2)
    expect(s.passages.S2.text).toBe('Search costs exceed execution costs in every draw.')
    expect(s.outline!.sections.at(-1)).toMatchObject({ id: 'SL', title: 'Limitations', role: 'limitations' })
    expect(s.passages.SL.text).toContain('Only one task family')
    // The Limitations section has no claims to check, and prints unnumbered after the conclusion.
    expect(fidelity.ready(paper).map((t) => t.key)).not.toContain('fidelity:SL')
    const { markdown } = await buildManuscript(paper)
    expect(markdown.indexOf('# Limitations {.unnumbered}')).toBeGreaterThan(markdown.indexOf('# Conclusion'))
    paper.settle('story:caveats', 'done')
    expect(storyTold(paper)).toBe(false)
    for (const step of STORY_STEPS) paper.settle(step.key, 'done')
    expect(copyedit.ready(paper).map((t) => t.key)).toEqual(['copyedit:text'])
  })

  it('undoes a change another family judges to change the research', async () => {
    const paper = reviewed()
    paper.ask = (async (options: { seat: string }) => options.seat === 'checker'
      ? { parts: [{ id: 'S2', verdict: 'changed', what: 'the result now holds for measured costs, not modeled ones' }] }
      : { edits: [{ in: 'S2', old: ' The cost model is not validated against measured training runs, so these are modeled costs.', new: '' }], limitations: '' }) as Paper['ask']
    await storyCaveats.ready(paper)[0].run()
    expect(paper.state.passages.S2.text).toContain('so these are modeled costs')
    expect(paper.state.notes.at(-1)?.text).toContain('would have changed the research')
  })

  it('leaves the text as it was when a worked number stays wrong', async () => {
    const paper = reviewed()
    for (const step of STORY_STEPS.slice(0, 2)) paper.settle(step.key, 'done')
    let asked = 0
    paper.ask = (async () => {
      asked++
      return { present: false, edits: [{ in: 'S2', old: 'Search costs exceed execution costs in every draw.', new: 'Search costs exceed execution costs in every draw. For example, with 50 inputs the reference budget is 50 × 52 × 51 / 2 = 66,400 gate equivalents.' }], calculations: [{ expression: '50 * 52 * 51 / 2', value: '66,400' }] }
    }) as Paper['ask']
    await storyExample.ready(paper)[0].run()
    expect(asked).toBe(2)
    expect(paper.state.passages.S2.text).not.toContain('For example')
  })

  it('reads the told paper through three times after the final frame, then lets it be proofread', async () => {
    const paper = reviewed()
    expect(storyRead.ready(paper)).toEqual([])
    paper.settle('frame:final', 'done')
    const readers: string[] = []
    paper.ask = (async (options: { seat: string; target: string; family: string }) => {
      if (options.target.startsWith('read-')) {
        readers.push(options.family)
        return { problems: options.target === 'read-1' ? [{ where: '[S3]', quote: 'Search dominates.', problem: 'It does not say what search dominates.', fix: 'Search cost dominates execution cost.' }] : [] }
      }
      if (options.seat === 'checker') return { parts: [{ id: 'S3', verdict: 'kept', what: '' }] }
      return { edits: [{ in: 'S3', old: 'Search dominates.', new: 'Search cost dominates execution cost.' }] }
    }) as Paper['ask']
    paper.settle(`typeset:${contentHash(paper)}`, 'done')
    for (let n = 1; n <= 3; n++) {
      expect(proof.ready(paper)).toEqual([])
      const [target] = storyRead.ready(paper)
      expect(target.key).toBe(`story:read:${n}`)
      await target.run()
      paper.settle(target.key, 'done')
    }
    expect(paper.state.passages.S3.text).toBe('Search cost dominates execution cost.')
    expect(readers).toEqual([paper.config.seats.checker, paper.config.seats.challenger, paper.config.seats.checker])
    expect(storyReadDone(paper)).toBe(true)
    paper.settle(`typeset:${contentHash(paper)}`, 'done')
    expect(proof.ready(paper).map((t) => t.key)).toEqual([`proof:${contentHash(paper)}`])
  })
})

describe('charts from the paper\'s own records', () => {
  const spec = {
    id: 'S1', title: 'First-year profit', method: 'monte_carlo', seed: 7, draws: 5000,
    inputs: [{ name: 'price', dist: 'triangular(8, 10, 14)' }, { name: 'volume', dist: 'lognormal(meanlog = 7, sdlog = 0.3)' }, { name: 'fixed', dist: '9000' }],
    model: [{ name: 'profit', expr: 'price * volume - fixed' }],
    outputs: ['profit'], events: [{ name: 'loss', when: 'profit < 0' }], correlations: [], sequential: null,
  }

  it('draws a histogram from the run\'s own draws and an interval from its summary', async () => {
    const paper = reviewed()
    const out = simulate(spec)
    if (!out.ok) throw new Error('spec did not run')
    paper.state.simulations = { S1: { id: 'S1', title: out.result.title, purpose: 'p', assumptions: [], result: out.result } }
    expect(chartCatalog(paper).map((d) => [d.ref, d.kinds])).toEqual([['sim:S1:profit', ['hist', 'interval']]])
    const hist = panelRows(paper, { kind: 'hist', data: ['sim:S1:profit'], labels: ['First year'], x: 'Profit', y: 'Draws', unit: 'EUR', marks: [] })
    if ('problem' in hist) throw new Error(hist.problem)
    expect(hist.rows.length).toBe(out.result.outputs.profit.n)
    const values = hist.rows.map((r) => Number(r.value)).sort((a, b) => a - b)
    expect(Math.abs(values[Math.floor(values.length / 2)] - out.result.outputs.profit.p50) / Math.abs(out.result.outputs.profit.p50)).toBeLessThan(1e-3)
    const interval = panelRows(paper, { kind: 'interval', data: ['sim:S1:profit', 'sim:S1:profit'], labels: ['a', 'b'], x: 'Profit', y: '', unit: 'EUR', marks: [] })
    if ('problem' in interval) throw new Error(interval.problem)
    expect(interval.rows[0]).toEqual({ label: 'a', estimate: out.result.outputs.profit.p50, lower: out.result.outputs.profit.p5, upper: out.result.outputs.profit.p95 })
    expect(toCsv(interval.rows).split('\n')[0]).toBe('label,estimate,lower,upper')
    expect(panelRows(paper, { kind: 'hist', data: ['sim:S9:profit'], labels: [], x: '', y: '', unit: '', marks: [] })).toEqual({ problem: 'sim:S9:profit is not a simulated quantity of this paper' })
  })

  it('draws no chart without Astetik, and says so', async () => {
    const paper = reviewed()
    for (const step of STORY_STEPS.slice(0, 4)) paper.settle(step.key, 'done')
    const out = simulate(spec)
    if (!out.ok) throw new Error('spec did not run')
    paper.state.simulations = { S1: { id: 'S1', title: out.result.title, purpose: 'p', assumptions: [], result: out.result } }
    const was = process.env.GALLEY_ASTETIK
    process.env.GALLEY_ASTETIK = join(dir, 'no-astetik')
    try {
      const drawn = await drawChart(paper, { id: 'chart1', caption: '', spec: '', sectionId: 'S2', status: 'planned', kind: 'chart', chart: { purpose: '', panels: [{ kind: 'hist', data: ['sim:S1:profit'], labels: [], x: '', y: '', unit: 'EUR', marks: [] }] } }, 'draw1')
      expect(drawn).toEqual({ ok: false, problem: expect.stringContaining('Astetik is not installed') })
      paper.ask = (async () => { throw new Error('no model is asked') }) as Paper['ask']
      await storyCharts.ready(paper).find((t) => t.key === 'story:charts')!.run()
      expect(paper.state.notes.at(-1)?.text).toContain('No charts')
    } finally {
      if (was === undefined) delete process.env.GALLEY_ASTETIK
      else process.env.GALLEY_ASTETIK = was
    }
  })
})
