// The story: the reviewed research is told without changing it. Its caveats gather in one Limitations section that
// prints after the conclusion without a number; a worked number must be what its arithmetic gives; a change that
// loses what the research rests on, or that another family judges changed the research, is undone; and a chart draws
// only the paper's own records.
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyedit } from '../../src/engine/behaviors/copyedit.js'
import { proof } from '../../src/engine/behaviors/proof.js'
import { STORY_STEPS, checkCalculation, madeTalk, renumber, researchLost, storyCaveats, storyCharts, storyExample, storyRead, storyReadDone, storyRegister, storyTold, writtenNumber } from '../../src/engine/behaviors/story.js'
import { fidelity } from '../../src/engine/behaviors/write.js'
import { chartCatalog, declaredFailure, drawChart, panelRows, toCsv } from '../../src/engine/charts.js'
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

  it('finds what the paper says of its own making, and sends it to be told as the work', async () => {
    expect(madeTalk('The weights are fixed. The simulation record does not establish whether they apply to variances. Each dataset was described by galley.')).toEqual([
      'The simulation record does not establish whether they apply to variances.', 'Each dataset was described by galley.',
    ])
    expect(madeTalk('Galley takes seats.', true)).toEqual([])
    const paper = reviewed()
    paper.state.passages.S2.text = 'Search costs exceed execution costs. The simulation record does not establish the weights.'
    for (const step of STORY_STEPS.slice(0, 3)) paper.settle(step.key, 'done')
    const prompts: string[] = []
    paper.ask = (async (options: { seat: string; prompt: string }) => {
      prompts.push(options.prompt)
      // An edit that says the same thing of the record again goes back once; then it is left as it was.
      return options.seat === 'checker' ? { parts: [] } : { edits: [{ in: 'S1', old: 'Scaling curves describe', new: 'As the production record shows, scaling curves describe' }] }
    }) as Paper['ask']
    await storyRegister.ready(paper)[0].run()
    expect(prompts[0]).toContain('- [S2] "The simulation record does not establish the weights."')
    expect(prompts).toHaveLength(2)
    expect(paper.state.passages.S1.text).toBe('Scaling curves describe what compute buys [@kaplan2020].')
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

  it('keeps no caveat moved when the Limitations section that would state it cannot stand', async () => {
    const paper = reviewed()
    let asked = 0
    paper.ask = (async (options: { seat: string }) => {
      if (options.seat === 'checker') return { parts: [{ id: 'S2', verdict: 'kept', what: '' }, { id: 'SL', verdict: 'changed', what: 'it says the calibration covers one method; it covers two' }] }
      asked++
      return { edits: [{ in: 'S2', old: ' The cost model is not validated against measured training runs, so these are modeled costs.', new: '' }], limitations: 'The calibration covers one method.' }
    }) as Paper['ask']
    await storyCaveats.ready(paper)[0].run()
    // The objection went back to the author once; still standing, it undoes the whole step.
    expect(asked).toBe(2)
    expect(paper.state.passages.S2.text).toContain('so these are modeled costs')
    expect(paper.state.outline!.sections.map((sec) => sec.id)).toEqual(['S1', 'S2', 'S3'])
  })

  it('undoes the part a sentence moved from when the part it moved into is undone', async () => {
    const paper = reviewed()
    for (const step of STORY_STEPS.slice(0, 3)) paper.settle(step.key, 'done')
    const moved = ' The cost model is not validated against measured training runs, so these are modeled costs.'
    paper.ask = (async (options: { seat: string }) => options.seat === 'checker'
      ? { parts: [{ id: 'S2', verdict: 'kept', what: '' }, { id: 'S3', verdict: 'changed', what: 'it weakens the conclusion' }] }
      : { edits: [{ in: 'S2', old: moved, new: '' }, { in: 'S3', old: 'Search dominates.', new: `Search dominates.${moved}` }] }) as Paper['ask']
    await storyRegister.ready(paper)[0].run()
    expect(paper.state.passages.S3.text).toBe('Search dominates.')
    expect(paper.state.passages.S2.text).toContain(moved.trim())
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

  it('keeps a figure whose replacing chart would drop the paper\'s only citation from its caption', async () => {
    const paper = reviewed()
    for (const step of STORY_STEPS.slice(0, 4)) paper.settle(step.key, 'done')
    const out = simulate(spec)
    if (!out.ok) throw new Error('spec did not run')
    paper.state.simulations = { S1: { id: 'S1', title: out.result.title, purpose: 'p', assumptions: [], result: out.result } }
    paper.state.passages.S1.text = 'Scaling curves describe what compute buys.'
    paper.state.figures = [{ id: 'F1', caption: 'Profit by run, as in earlier work [@kaplan2020].', spec: '', sectionId: 'S2', status: 'rendered', file: 'figures/F1.png' }]
    const fake = join(dir, 'astetik')
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = catalog ]; then echo \'{"plots":{"hist":{"options":[]},"interval":{"options":[]}},"spec_fields":[]}\'; else exit 2; fi\n')
    chmodSync(fake, 0o755)
    const was = process.env.GALLEY_ASTETIK
    process.env.GALLEY_ASTETIK = fake
    try {
      paper.ask = (async () => ({ charts: [{ section: 'S2', replaces: 'F1', purpose: 'p', caption: 'Profit by run.', panels: [{ kind: 'hist', data: ['sim:S1:profit'], labels: ['a'], x: 'Profit', y: 'Draws', unit: 'EUR', x_unit: '', marks: [] }], mention: { old: '', new: '' } }] })) as Paper['ask']
      await storyCharts.ready(paper).find((t) => t.key === 'story:charts')!.run()
      expect(paper.state.notes.at(-1)?.text).toContain("removes the paper's only citation of @kaplan2020")
      expect(paper.state.figures[0]).toMatchObject({ id: 'F1', caption: 'Profit by run, as in earlier work [@kaplan2020].', file: 'figures/F1.png' })
    } finally {
      if (was === undefined) delete process.env.GALLEY_ASTETIK
      else process.env.GALLEY_ASTETIK = was
    }
  })

  // With Astetik installed on this machine, galley draws real charts from its records: nothing typed, every check passed.
  const real = join(homedir(), '.galley', 'astetik', '.venv', 'bin', 'astetik')
  it.skipIf(!existsSync(real))('draws a histogram of two runs and a course with its band through the installed Astetik', async () => {
    const paper = reviewed()
    const one = simulate(spec), two = simulate({ ...spec, id: 'S2', seed: 8 })
    if (!one.ok || !two.ok) throw new Error('spec did not run')
    const steps = { t: Array.from({ length: 12 }, (_, i) => i), ess: [], bands: { stock: { mean: Array.from({ length: 12 }, (_, i) => 10 + i), p5: Array.from({ length: 12 }, (_, i) => 8 + i * 0.8), p50: Array.from({ length: 12 }, (_, i) => 10 + i), p95: Array.from({ length: 12 }, (_, i) => 12 + i * 1.2) } } }
    paper.state.simulations = {
      S1: { id: 'S1', title: 'Profit', purpose: 'p', assumptions: [], result: one.result },
      S2: { id: 'S2', title: 'Profit, other seed', purpose: 'p', assumptions: [], result: two.result },
      S4: { id: 'S4', title: 'Stock', purpose: 'p', assumptions: [], result: { ...one.result, id: 'S4', series: { ...one.result.series, steps } } },
    }
    const was = process.env.GALLEY_ASTETIK
    process.env.GALLEY_ASTETIK = real
    try {
      const hist = await drawChart(paper, { id: 'chart1', caption: '', spec: '', sectionId: 'S2', status: 'planned', kind: 'chart', chart: { purpose: '', panels: [{ kind: 'hist', data: ['sim:S1:profit', 'sim:S2:profit'], labels: ['Base', 'Other seed'], x: 'First-year profit', y: 'Draws', unit: 'EUR', group: 'Run', marks: [] }] } }, 'test')
      expect(hist).toMatchObject({ ok: true, file: 'figures/chart1.png' })
      expect(existsSync(paper.path('build', 'figures', 'chart1.png'))).toBe(true)
      const line = await drawChart(paper, { id: 'chart2', caption: '', spec: '', sectionId: 'S2', status: 'planned', kind: 'chart', chart: { purpose: '', panels: [{ kind: 'line', data: ['steps:S4:stock'], labels: ['Stock'], x: 'Day', y: 'Stock', unit: 'units', xUnit: 'd', marks: [] }] } }, 'test')
      expect(line).toMatchObject({ ok: true, file: 'figures/chart2.png' })
    } finally {
      if (was === undefined) delete process.env.GALLEY_ASTETIK
      else process.env.GALLEY_ASTETIK = was
    }
  }, 120_000)

  it('reads what Astetik\'s checks found from its report, past the warnings before it', () => {
    const stderr = 'Matplotlib is building the font cache; this may take a moment.\n/x/_plot_backend.py:133: UserWarning: Glyph 955 missing\n  cast(NativeCanvas, figure.canvas).draw()\n' + JSON.stringify({ code: 'PAPER_VERIFICATION', message: 'Paper output failed publication checks.', details: { report: { checks: [
      { check: 'label_clipping', passed: false, issues: [{ text: 'Calibration run: S3, lowest-budget corner' }] },
      { check: 'glyph_coverage', passed: false, issues: [{ text: 'memory weight λ = 1', missing: [{ character: 'λ' }] }] },
      { check: 'minimum_type_size', passed: true },
    ] } } })
    expect(declaredFailure(stderr)).toBe('Paper output failed publication checks. (label clipping: "Calibration run: S3, lowest-budget corner"; glyph coverage: "memory weight λ = 1" lacks λ)')
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
