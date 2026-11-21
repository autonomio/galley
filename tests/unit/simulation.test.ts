// The simulation engine against what is known exactly: the moments and quantiles of distributions,
// a stated rank correlation, the Kalman filter, and the seed. Every run is seeded, so a bound that
// holds once holds every time.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atPrecision, compare, expectedOf, placeholders, simulate, specSchema, validate, writeReproduction, type Expected, type SimulationResult } from '../../src/engine/simulation/index.js'

const run = (spec: object): SimulationResult => {
  const out = simulate(spec)
  if (!out.ok) throw new Error(JSON.stringify(out.problems))
  return out.result
}
const base = { title: 'a test', seed: 7, draws: 20000, model: [], events: [], correlations: [], sequential: null }
const within = (value: number, exact: number, mcse: number, k = 4) => expect(Math.abs(value - exact)).toBeLessThanOrEqual(k * mcse)

const EXACT_MEANS: Record<string, [string, number]> = {
  n: ['normal(10, 2)', 10],
  g: ['gamma(shape = 3, rate = 2)', 1.5],
  b: ['beta(2, 5)', 2 / 7],
  k: ['poisson(4)', 4],
  tri: ['triangular(0, 1, 4)', 5 / 3],
  ln: ['lognormal(0, 0.5)', Math.exp(0.125)],
  pe: ['pert(0, 2, 10)', 3],
  bi: ['binomial(20, 0.3)', 6],
  tn: ['truncnormal(0, 1, 1, inf)', 0.24197072451914337 / 0.15865525393145707],
  c: ['categorical(1, 2, 7)', 2.6],
}
const known = run({
  ...base, id: 'S1', method: 'monte_carlo',
  inputs: Object.entries(EXACT_MEANS).map(([name, [dist]]) => ({ name, dist })),
  outputs: Object.keys(EXACT_MEANS),
  events: [{ name: 'high', when: 'n > 12' }, { name: 'never', when: 'n > 1000' }],
})

// Linear Gaussian observations, drawn apart from the engine.
function series(steps: number) {
  let s = 12345
  const u = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296 + 1e-12
  const gauss = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u())
  let x = gauss()
  return Array.from({ length: steps }, () => { x = 0.9 * x + 0.5 * gauss(); return x + 0.8 * gauss() })
}

describe('simulation engine', () => {
  it('writes the shares of one run at one precision, so a breakdown never sets 7.3% beside 3.64%', () => {
    const r = run({ ...base, id: 'P1', method: 'monte_carlo', draws: 50000, inputs: [{ name: 'u', dist: 'uniform(0, 1)' }], outputs: ['u'], events: [{ name: 'a', when: 'u < 0.073' }, { name: 'b', when: 'u < 0.0364' }, { name: 'rare', when: 'u < 0.0005' }] })
    const values = placeholders(r)
    expect(values['sim.P1.a.p']).toMatch(/^\d+\.\d%$/)
    expect(values['sim.P1.b.p']).toMatch(/^\d+\.\d%$/)
    // A share below 1% keeps the digits its own error supports.
    expect(values['sim.P1.rare.p']).toMatch(/^0\.0\d+%$/)
  })

  it('draws known distributions: means and quantiles fall within their Monte Carlo error', () => {
    for (const [name, [, mean]] of Object.entries(EXACT_MEANS)) within(known.outputs[name].mean, mean, known.outputs[name].mcse.mean)
    const n = known.outputs.n
    within(n.p50, 10, n.mcse.p50)
    within(n.p95, 10 + 2 * 1.6448536269514729, n.mcse.p95)
    within(known.events.high.p, 0.15865525393145707, known.events.high.mcse)
    expect(known.provenance).toMatchObject({ engine: 'galley-simulation-1', method: 'monte_carlo', seed: 7, size: { draws: 20000 }, ok: true })
  })

  it('recovers a stated rank correlation while every input keeps its distribution', () => {
    const r = run({
      ...base, id: 'S2', method: 'correlated',
      inputs: [{ name: 'a', dist: 'normal(0, 1)' }, { name: 'b', dist: 'gamma(2, 1)' }, { name: 'c', dist: 'uniform(0, 10)' }],
      outputs: ['a', 'b', 'c'], correlations: [{ a: 'a', b: 'b', rho: 0.7 }, { a: 'a', b: 'c', rho: -0.4 }],
    })
    for (const c of r.diagnostics.correlations as { target: number; achieved: number }[]) expect(Math.abs(c.achieved - c.target)).toBeLessThan(0.02)
    within(r.outputs.b.mean, 2, r.outputs.b.mcse.mean)
    within(r.outputs.c.p50, 5, r.outputs.c.mcse.p50)
    // Correlations that cannot hold together run with the nearest set that can, and say so.
    const repaired = run({
      ...base, id: 'S3', method: 'correlated', draws: 2000,
      inputs: ['a', 'b', 'c'].map((name) => ({ name, dist: 'normal(0, 1)' })), outputs: ['a'],
      correlations: [{ a: 'a', b: 'b', rho: 0.9 }, { a: 'b', b: 'c', rho: 0.9 }, { a: 'a', b: 'c', rho: -0.9 }],
    })
    expect(repaired.provenance.checks.find((c) => c.name === 'correlations')?.ok).toBe(false)
  })

  it('agrees with the Kalman filter on a linear Gaussian model, and simulates forward', () => {
    const ys = series(30)
    let m = 0
    let P = 1
    let loglik = 0
    for (const y of ys) {
      m *= 0.9
      P = 0.81 * P + 0.25
      const S = P + 0.64
      loglik += -0.5 * Math.log(2 * Math.PI * S) - (y - m) ** 2 / (2 * S)
      m += (P / S) * (y - m)
      P *= 1 - P / S
    }
    const r = run({
      ...base, id: 'K1', method: 'sequential', draws: null, outputs: ['x'],
      sequential: { states: [{ name: 'x', init: 'normal(0, 1)', next: 'normal(0.9 * x, 0.5)' }], observations: [{ name: 'y', values: ys, likelihood: 'normal(x, 0.8)' }], steps: null, particles: 500, replicates: 8, resample: 'systematic', threshold: 0.5 },
    })
    within(r.outputs.x.mean, m, r.outputs.x.mcse.mean)
    within(r.outputs.x.sd, Math.sqrt(P), r.outputs.x.mcse.sd)
    const L = r.numbers.find((n) => n.key === 'loglik')!
    within(L.value, loglik, L.mcse!)
    expect(r.series.steps?.t).toHaveLength(31)
    // With nothing observed it is a forward simulation: a random walk spreads as the square root of its steps.
    const walk = run({
      ...base, id: 'W1', method: 'sequential', draws: null, outputs: ['x'],
      sequential: { states: [{ name: 'x', init: '0', next: 'normal(x, 1)' }], observations: [], steps: 25, particles: 500, replicates: 4, resample: null, threshold: null },
    })
    within(walk.outputs.x.sd, 5, walk.outputs.x.mcse.sd)
  })

  it('gives the same numbers for the same spec and seed, and an input keeps its draws when others change', () => {
    const spec = { ...base, id: 'S4', method: 'monte_carlo', draws: 2000, inputs: [{ name: 'x', dist: 'lognormal(1, 0.4)' }], model: [{ name: 'y', expr: 'x ^ 2' }], outputs: ['x', 'y'] }
    const strip = (r: SimulationResult) => ({ ...r, provenance: { ...r.provenance, runtimeMs: 0 } })
    expect(strip(run(spec))).toEqual(strip(run(spec)))
    expect(run({ ...spec, seed: 8 }).outputs.x.mean).not.toBe(run(spec).outputs.x.mean)
    const more = run({ ...spec, inputs: [{ name: 'w', dist: 'uniform(0, 1)' }, ...spec.inputs], outputs: ['x', 'w'] })
    expect(more.outputs.x).toEqual(run(spec).outputs.x)
  })

  it('reads expressions as data: precedence holds, and nothing a model writes runs as code', () => {
    const r = run({ ...base, id: 'S5', method: 'monte_carlo', draws: 100, inputs: [{ name: 'x', dist: '3' }], model: [{ name: 'ok', expr: '2 ^ 3 ^ 2 == 512 and -x ^ 2 == -9 and not (1 > 2) and if(x > 2, 1, 0) and pick(2, 5, x) == 3' }], outputs: ['ok'] })
    expect(r.outputs.ok.mean).toBe(1)
    for (const expr of ['x.constructor', 'constructor', '__proto__', 'process.exit(1)', 'eval("1")', 'Function("return 1")()', 'this', '`1`', 'x; x']) {
      expect(validate({ ...base, id: 'S6', method: 'monte_carlo', inputs: [{ name: 'x', dist: '1' }], model: [{ name: 'y', expr }], outputs: ['y'] }).length).toBeGreaterThan(0)
    }
    const dir = join(import.meta.dirname, '../../src/engine/simulation')
    const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]))
    for (const file of files(dir)) expect(readFileSync(file, 'utf8')).not.toMatch(/\beval\s*\(|\bFunction\s*\(|new Function/)
  })

  it('returns what keeps a spec from running as located problems, with the fix', () => {
    const problems = validate({
      ...base, id: 'S7', method: 'monte_carlo',
      inputs: [{ name: 'revenue', dist: 'normal(100, 10)' }, { name: 'cost', dist: 'gamma(shape = 2, scale = 3)' }, { name: 'n', dist: 'normul(1, 2)' }],
      model: [{ name: 'profit', expr: 'revenu - cost' }, { name: 'a', expr: 'b + 1' }, { name: 'b', expr: 'a + 1' }],
      outputs: ['profit'], correlations: [{ a: 'revenue', b: 'cost', rho: 0.5 }],
    })
    const at = (path: string) => problems.find((p) => p.at === path)?.message ?? ''
    expect(at('inputs[1].dist')).toMatch(/no parameter scale; its parameters are shape and rate/)
    expect(at('inputs[2].dist')).toMatch(/there is no function or distribution normul; did you mean normal/)
    expect(at('model[0].expr')).toMatch(/nothing is called revenu; did you mean revenue/)
    expect(problems.some((p) => /closes a loop/.test(p.message))).toBe(true)
    expect(at('correlations')).toMatch(/method "correlated"/)
    expect(validate('not json')).toEqual([{ at: '', message: 'a simulation is a JSON object' }])
  })

  it('cites results by placeholder, at the precision their error supports', () => {
    const values = placeholders(known)
    for (const key of Object.keys(values)) expect(key).toMatch(/^sim\.S1\.[A-Za-z0-9_.]+$/)
    expect(values['sim.S1.draws']).toBe('20,000')
    expect(values['sim.S1.n.mean']).toBe(atPrecision(known.outputs.n.mean, known.outputs.n.mcse.mean))
    expect(values['sim.S1.never.p']).toBe('< 0.02%')
    expect([atPrecision(12436.27, 41), atPrecision(0.31234, 0.0033), atPrecision(2015, null), atPrecision(-0.0004, 0.003)]).toEqual(['12,440', '0.312', '2015', '0.000'])
    // A check at the cited precision stays one step wide however large the number.
    const big = run({ ...base, id: 'S8', method: 'monte_carlo', draws: 100, inputs: [{ name: 'big', dist: '1e15' }], outputs: ['big'] })
    const cited = expectedOf(big)
    expect(compare(cited, big).ok).toBe(true)
    cited.numbers.find((n) => n.key === 'sim.S8.big.mean')!.value = '1,000,000,000,000,100'
    expect(compare(cited, big).differences.map((d) => d.key)).toEqual(['sim.S8.big.mean'])
  })

  it('publishes a reproduction package that reruns with Node alone and verifies what the paper cites', () => {
    const out = mkdtempSync(join(tmpdir(), 'galley-reproduction-'))
    const dir = join(out, 'simulation')
    try {
      const walk = run({
        ...base, id: 'W2', method: 'sequential', draws: null, model: [{ name: 'none', expr: 'log(0 - 1)' }], outputs: ['x', 'none'], events: [{ name: 'far', when: 'abs(x) > 3' }],
        sequential: { states: [{ name: 'x', init: '0', next: 'normal(x, 1)' }], observations: [], steps: 10, particles: 200, replicates: 2, resample: null, threshold: null },
      })
      // As typeset passes them: runs stored in the paper's state, back from JSON, where NaN became null.
      const stored = (r: SimulationResult) => JSON.parse(JSON.stringify(r)) as SimulationResult
      const checks: boolean[] = []
      const files = writeReproduction(dir, [
        { id: 'S1', title: 'Known distributions', purpose: 'Checks the engine.', assumptions: [{ name: 'n', basis: 'a textbook normal' }], result: stored(known) },
        { id: 'W2', title: 'A random walk', purpose: 'Spreads with time.', assumptions: [], result: stored(walk) },
      ], { title: 'A test paper', verified: (check) => checks.push(check.ok) })
      expect(files.map((f) => relative(dir, f).split(sep).join('/')).sort()).toEqual(['README.md', 'SPEC.md', 'engine.mjs', 'expected/S1.json', 'expected/W2.json', 'index.html', 'simulate.mjs', 'specs/S1.json', 'specs/W2.json'])
      expect(checks).toEqual([true])
      expect(readFileSync(join(dir, 'README.md'), 'utf8')).toMatch(/and every number matched/)
      const node = (...args: string[]) => spawnSync(process.execPath, [join(dir, 'simulate.mjs'), ...args], { encoding: 'utf8' })
      expect(node('--verify').status).toBe(0)
      // A published simulation whose spec went missing fails the check.
      renameSync(join(dir, 'specs', 'W2.json'), join(out, 'W2.json'))
      const incomplete = node('--verify')
      expect(incomplete.status).toBe(1)
      expect(incomplete.stdout).toMatch(/W2 {2}expected\/W2\.json has no spec/)
      renameSync(join(out, 'W2.json'), join(dir, 'specs', 'W2.json'))
      // A number the paper states otherwise fails the check, and the difference is shown.
      const file = join(dir, 'expected', 'S1.json')
      const expected = JSON.parse(readFileSync(file, 'utf8')) as Expected
      expected.numbers.find((n) => n.key === 'sim.S1.n.mean')!.value = '10.50'
      writeFileSync(file, JSON.stringify(expected))
      const failed = node('--verify')
      expect(failed.status).toBe(1)
      expect(failed.stdout).toMatch(/\{\{sim\.S1\.n\.mean\}\}\s+10\.50\s+9\.99/)
      // A paper that dropped its simulations publishes none: the package goes.
      expect(writeReproduction(dir, [])).toEqual([])
      expect(existsSync(dir)).toBe(false)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('keeps its spec schema in the strict dialect every provider accepts', () => {
    const walk = (s: any): void => {
      if (s.properties) {
        expect(s.additionalProperties).toBe(false)
        expect(s.required).toEqual(Object.keys(s.properties))
        Object.values(s.properties).forEach(walk)
      }
      if (s.items) walk(s.items)
    }
    walk(specSchema)
  })
})
