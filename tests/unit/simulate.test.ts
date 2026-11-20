// A paper's simulation: the plan waits for it, every prompt sees its model and
// its numbers under placeholders, and the production record fills them in.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { plan } from '../../src/engine/behaviors/front.js'
import { simulateModel } from '../../src/engine/behaviors/simulate.js'
import { Paper } from '../../src/engine/paper.js'
import { fillPlaceholders, productionRecord } from '../../src/engine/record.js'
import { simulate } from '../../src/engine/simulation/index.js'
import { simulationsBlock } from '../../src/engine/simulations.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const spec = {
  id: 'S1', title: 'First-year profit', method: 'monte_carlo', seed: 7, draws: 5000,
  inputs: [{ name: 'price', dist: 'triangular(8, 10, 14)' }, { name: 'volume', dist: 'lognormal(meanlog = 7, sdlog = 0.3)' }, { name: 'fixed', dist: '9000' }],
  model: [{ name: 'profit', expr: 'price * volume - fixed' }],
  outputs: ['profit'], events: [{ name: 'loss', when: 'profit < 0' }], correlations: [], sequential: null,
}

describe('simulation in a paper', () => {
  it('holds the plan until the simulation has run, then shows its numbers under placeholders the record fills', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed', { simulation: true, off: ['position', 'review-idea'] })
    const s = paper.state
    s.brief = { hasSubject: true, concern: 'c', contribution: 'k', objectType: 'finding', field: 'economics', audience: 'a' }
    expect(simulateModel.ready(paper).map((t) => t.key)).toEqual(['simulate:paper'])
    expect(plan.ready(paper)).toEqual([])

    const out = simulate(spec)
    if (!out.ok) throw new Error(JSON.stringify(out.problems))
    s.simulations = { S1: { id: 'S1', title: out.result.title, purpose: 'Shows how often the first year loses money.', assumptions: [{ name: 'price', basis: 'the seed\'s price range' }], result: out.result } }
    expect(simulateModel.ready(paper)).toEqual([])
    expect(plan.ready(paper).map((t) => t.key)).toEqual(['plan:argument'])

    const block = simulationsBlock(paper)
    expect(block).toContain('price ~ triangular(8, 10, 14) (basis: the seed\'s price range)')
    expect(block).toMatch(/\{\{sim\.S1\.profit\.p95\}\} = [\d,.]+ /)
    expect(block).toMatch(/\{\{sim\.S1\.loss\.p\}\} = [<>\d.,% ]+/)
    const filled = fillPlaceholders('A loss in {{sim.S1.loss.p}} of years; the 95th percentile is {{sim.S1.profit.p95}}.', productionRecord(paper))
    expect(filled.unknown).toEqual([])
    expect(filled.text).not.toContain('{{')
  })
})

describe('a simulation paper as published', () => {
  it('points its availability statement at the runnable reproduction', async () => {
    const { buildManuscript } = await import('../../src/engine/render.js')
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed', { simulation: true })
    const out = simulate(spec)
    if (!out.ok) throw new Error('spec did not run')
    const s = paper.state
    s.simulations = { S1: { id: 'S1', title: out.result.title, purpose: 'p', assumptions: [], result: out.result } }
    s.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: [], words: 200, figureIds: [] }], style: '', glossary: [] }
    s.passages = { S1: { sectionId: 'S1', text: 'A loss in {{sim.S1.loss.p}} of years.', revisions: [], checked: 'faithful' } }
    s.frame = { title: 'Profit', abstract: 'a', keywords: [], limitations: '', opens: '' }
    const { markdown } = await buildManuscript(paper)
    expect(markdown).toContain('node simulate.mjs --verify')
    expect(markdown).not.toContain('{{sim.')
  })
})

describe('the claim ledger as published', () => {
  it('fills the numbers its claims carry, as the body does', async () => {
    const { buildManuscript } = await import('../../src/engine/render.js')
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const s = paper.state
    s.measurements = { A1: { id: 'A1', spec: { id: 'A1', dataset: 'M1', op: 'quantile', column: 'Delay ms', column2: null, by: null, value: '0.99', where: null }, value: '422.2', summary: '99th percentile of Delay ms: 422.2, n = 147', n: 147 } }
    s.claims = [{ id: 'C1', text: 'The 99th-percentile switchover latency is {{data.A1}} ms.', kind: 'contribution', seedQuote: '', origin: 'system', need: 'internal', loadBearing: true, dependsOn: [], status: 'internal', history: [] }]
    s.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: ['C1'], words: 200, figureIds: [] }], style: '', glossary: [] }
    s.passages = { S1: { sectionId: 'S1', text: 'The 99th percentile is {{data.A1}} ms.', revisions: [], checked: 'faithful' } }
    s.frame = { title: 'Latency', abstract: 'a', keywords: [], limitations: '', opens: '' }
    s.figures = [{ id: 'fig1', caption: 'Switchover delay; the 99th percentile is {{data.A1}} ms.', spec: '', sectionId: 'S1', status: 'rendered', file: 'figures/fig1.png' }]
    const { markdown } = await buildManuscript(paper)
    // A number keeps its unit on the same line: they are joined by a no-break space.
    expect(markdown).toContain('the 99th percentile is 422.2 ms.](figures/fig1.png)')
    const ledger = markdown.slice(markdown.indexOf('# Appendix A'))
    expect(ledger).toContain('The 99th-percentile switchover latency is 422.2 ms.')
    expect(markdown).not.toContain('{{data.')
  })
})
