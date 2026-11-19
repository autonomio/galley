// Sequential Monte Carlo: a bootstrap particle filter over a state-space model. Particles start
// from the states' initial distributions, move by the transitions step by step, and are weighted
// by the likelihood of each step's observations given their state; when the effective sample
// size (ESS) falls below a share of the particles, they are resampled. With nothing observed it
// is a forward simulation of the states. Independent filters run side by side, so every estimate's
// Monte Carlo error comes from how far they disagree: resampling makes the particles of one filter
// depend on each other, which no single-filter formula captures.
import { compileField, drawValue, scopeOf, type Field } from '../model.js'
import type { Stream } from '../random.js'
import { logMeanExp } from '../special.js'
import { band, sampleSd } from '../stats.js'
import type { Check, Draw, Draws, Method, MethodNumber, Resampling, Sample, StepSeries } from '../types.js'

export const PARTICLES = { default: 1000, min: 50, max: 50000 }
export const REPLICATES = { default: 8, min: 2, max: 32 }
export const STEPS = { max: 10000 }
/** Particles × replicates × steps one run may take. */
export const MAX_WORK = 2e7
const SERIES_POINTS = 100

interface Plan {
  states: { name: string; slot: number; init: Field; next: Field }[]
  observations: { name: string; values: Float64Array; likelihood: Draw }[]
  steps: number
  particles: number
  replicates: number
  resample: Resampling
  threshold: number
  tSlot: number
}

const bounded = (asked: number | null, range: { default: number; min: number; max: number }, what: string, notes: Check[]) => {
  const value = Math.min(range.max, Math.max(range.min, Math.round(asked ?? range.default)))
  if (asked !== null && value !== asked) notes.push({ name: what, ok: false, detail: `${asked} ${what} were asked for; the run used ${value} (the engine allows ${range.min} to ${range.max})` })
  return value
}

/** Ancestor indices for the next generation, from normalized weights. */
function resample(kind: Resampling, weights: Float64Array, stream: Stream, out: Int32Array) {
  const n = weights.length
  const u = new Float64Array(n)
  if (kind === 'multinomial') {
    // Sorted uniforms from cumulative exponential spacings, so the walk below needs no sort.
    let total = 0
    for (let k = 0; k < n; k++) { total -= Math.log(stream.next()); u[k] = total }
    total -= Math.log(stream.next())
    for (let k = 0; k < n; k++) u[k] /= total
  } else {
    const shift = kind === 'systematic' ? stream.next() : 0
    for (let k = 0; k < n; k++) u[k] = (k + (kind === 'systematic' ? shift : stream.next())) / n
  }
  let j = 0
  let cum = weights[0]
  for (let k = 0; k < n; k++) {
    while (u[k] > cum && j < n - 1) cum += weights[++j]
    out[k] = j
  }
}

export const sequential: Method<Plan> = {
  name: 'sequential',
  about: 'a state that moves step by step, as a bootstrap particle filter: weighted by the observations when there are any, a forward simulation when there are none',
  scope: (spec) => [
    ...(spec.sequential?.states ?? []).map((s, i) => ({ name: s.name, at: `sequential.states[${i}].name` })),
    { name: 't', at: 'sequential', system: true },
  ],
  prepare(spec, model, problems, notes) {
    const say = (at: string, message: string) => problems.push({ at, message })
    const seq = spec.sequential
    const plan: Plan = { states: [], observations: [], steps: 0, particles: 0, replicates: 0, resample: 'systematic', threshold: 0.5, tSlot: model.slots.get('t') ?? 0 }
    if (!seq) { say('sequential', 'method "sequential" needs its states: give sequential {states, observations, steps, …}'); return plan }
    if (spec.correlations.length) say('correlations', 'correlations need method "correlated"; the sequential method draws its inputs on their own')
    if (spec.draws !== null) notes.push({ name: 'draws', ok: true, detail: 'draws does not apply to the sequential method; particles and replicates set its size' })
    if (!seq.states.length) say('sequential.states', 'it needs at least one state')
    if (seq.states.length > 32) say('sequential.states', `at most 32 states, not ${seq.states.length}`)
    if (seq.observations.length > 8) say('sequential.observations', `at most 8 observed series, not ${seq.observations.length}`)
    const inputs = spec.inputs.map((x) => x.name)
    const states = seq.states.map((s) => s.name)
    const later = scopeOf(model.slots, [...inputs, ...states, ...spec.model.map((m) => m.name), 't'])
    for (const [i, s] of seq.states.entries()) {
      // A state starts from the inputs and the states listed before it; the model lines are not computed yet.
      const init = compileField(s.init, `sequential.states[${i}].init`, scopeOf(model.slots, [...inputs, ...states.slice(0, i)]), 'either', problems)
      const next = compileField(s.next, `sequential.states[${i}].next`, later, 'either', problems)
      if (init && next && model.slots.has(s.name)) plan.states.push({ name: s.name, slot: model.slots.get(s.name)!, init, next })
    }
    const length = seq.observations[0]?.values.length ?? 0
    for (const [i, o] of seq.observations.entries()) {
      const at = `sequential.observations[${i}]`
      if (o.values.length !== length) say(`${at}.values`, `it has ${o.values.length} values where observations[0] has ${length}; every series has one value per step`)
      const likelihood = compileField(o.likelihood, `${at}.likelihood`, later, 'draw', problems)
      if (likelihood?.kind === 'draw') plan.observations.push({ name: o.name, values: Float64Array.from(o.values, (v) => (v === null ? NaN : v)), likelihood: likelihood.draw })
    }
    if (seq.observations.length) {
      plan.steps = length
      if (!length) say('sequential.observations[0].values', 'an observed series needs at least one value')
      if (seq.steps !== null && seq.steps !== length) notes.push({ name: 'steps', ok: true, detail: `steps is ${seq.steps} but the observations have ${length} values; the run follows the observations` })
    } else if (seq.steps === null) say('sequential.steps', 'with nothing observed, steps says how many steps to run')
    else if (!(Number.isInteger(seq.steps) && seq.steps >= 1)) say('sequential.steps', `steps must be a whole number from 1, not ${seq.steps}`)
    else plan.steps = seq.steps
    if (plan.steps > STEPS.max) say('sequential.steps', `at most ${STEPS.max} steps, not ${plan.steps}`)
    plan.replicates = bounded(seq.replicates, REPLICATES, 'replicates', notes)
    plan.particles = bounded(seq.particles, PARTICLES, 'particles', notes)
    if (plan.steps > 0 && plan.particles * plan.replicates * plan.steps > MAX_WORK) {
      const fit = Math.max(PARTICLES.min, Math.floor(MAX_WORK / (plan.replicates * plan.steps)))
      notes.push({ name: 'particles', ok: false, detail: `${plan.particles} particles in ${plan.replicates} filters over ${plan.steps} steps is more than one run takes; the run used ${fit} particles per filter` })
      plan.particles = fit
    }
    plan.resample = seq.resample ?? 'systematic'
    plan.threshold = seq.threshold ?? 0.5
    if (!(plan.threshold >= 0 && plan.threshold <= 1)) {
      notes.push({ name: 'threshold', ok: false, detail: `threshold ${seq.threshold} is not a share between 0 and 1; the run used 0.5` })
      plan.threshold = 0.5
    }
    return plan
  },
  run(plan, model, ctx): Draws {
    const { particles: N, replicates: R, steps: T, tSlot } = plan
    const size = model.size
    const env = new Float64Array(size)
    const fields = [...plan.states.flatMap((s) => [s.init, s.next]), ...plan.observations.map((o) => ({ kind: 'draw' as const, draw: o.likelihood }))]
    const args = new Float64Array(Math.max(1, ...fields.map((f) => (f.kind === 'draw' ? f.draw.args.length : 0))))
    const kept = [...model.outputs, ...model.events]
    const bandNames = model.outputs.map((o) => o.name)
    const every = Math.max(1, Math.ceil(T / SERIES_POINTS))
    const recorded = (t: number) => t === 0 || t === T || t % every === 0
    const series: StepSeries = { t: [], ess: [], bands: Object.fromEntries(bandNames.map((n) => [n, { mean: [], p5: [], p50: [], p95: [] }])) }
    const observed = plan.observations.length > 0
    let killed = 0
    const collapses: { filter: number; step: number }[] = []

    const value = (field: Field, stream: Stream): number => {
      if (field.kind === 'expr') return field.fn(env)
      const u = stream.next()
      const draw = field.draw
      for (let k = 0; k < draw.args.length; k++) args[k] = draw.args[k](env)
      return drawValue(draw, args, u)
    }

    const filters = Array.from({ length: R }, (_, r) => ({
      rows: new Float64Array(N * size),
      spare: new Float64Array(N * size),
      weights: new Float64Array(N).fill(1 / N),
      ll: new Float64Array(N),
      ancestors: new Int32Array(N),
      logZ: 0,
      resampled: 0,
      essMin: N,
      init: plan.states.map((s) => ctx.stream('sequential', r, 'init', s.name)),
      next: plan.states.map((s) => ctx.stream('sequential', r, 'next', s.name)),
      inputs: model.inputs.map((x) => (x.draw ? ctx.stream('sequential', r, 'input', x.name) : null)),
      shuffle: ctx.stream('sequential', r, 'resample'),
    }))

    const record = (t: number, ess: number[]) => {
      series.t.push(t)
      series.ess.push(ess.reduce((a, b) => a + b, 0) / ess.length)
      for (const o of model.outputs) {
        const values = new Float64Array(N * R)
        const weights = new Float64Array(N * R)
        filters.forEach((f, r) => {
          for (let i = 0; i < N; i++) {
            values[r * N + i] = f.rows[i * size + o.slot]
            weights[r * N + i] = f.weights[i] / R
          }
        })
        const b = band(values, weights)
        const out = series.bands[o.name]
        out.mean.push(b.mean); out.p5.push(b.p5); out.p50.push(b.p50); out.p95.push(b.p95)
      }
    }

    // The particles at t = 0: inputs drawn once per particle, then the states' initial values.
    for (const f of filters) {
      for (let i = 0; i < N; i++) {
        env.fill(NaN)
        for (const [k, x] of model.inputs.entries()) env[x.slot] = x.draw ? x.draw.dist.quantile(f.inputs[k]!.next(), x.args, x.args.length) : x.value
        env[tSlot] = 0
        for (const [k, s] of plan.states.entries()) env[s.slot] = value(s.init, f.init[k])
        model.derive(env)
        f.rows.set(env, i * size)
      }
    }
    if (recorded(0)) record(0, filters.map(() => N))

    for (let t = 1; t <= T; t++) {
      const essNow: number[] = []
      for (const [r, f] of filters.entries()) {
        for (let i = 0; i < N; i++) {
          const base = i * size
          for (let j = 0; j < size; j++) env[j] = f.rows[base + j]
          env[tSlot] = t
          // States update in the listed order, so each name reads its newest value.
          for (const [k, s] of plan.states.entries()) env[s.slot] = value(s.next, f.next[k])
          model.derive(env)
          let ll = 0
          for (const s of plan.states) if (!Number.isFinite(env[s.slot])) ll = -Infinity
          if (ll === -Infinity) { if (f.weights[i] > 0) killed++ }
          else {
            for (const o of plan.observations) {
              const y = o.values[t - 1]
              if (y !== y) continue
              for (let k = 0; k < o.likelihood.args.length; k++) args[k] = o.likelihood.args[k](env)
              ll += o.likelihood.dist.invalid(args, o.likelihood.args.length) ? -Infinity : o.likelihood.dist.logpdf(y, args, o.likelihood.args.length)
            }
          }
          f.ll[i] = ll
          f.rows.set(env, base)
        }
        // Reweight in the log domain: the increment's log-mean is this step's share of the log-likelihood.
        let top = -Infinity
        for (let i = 0; i < N; i++) {
          const a = Math.log(f.weights[i]) + f.ll[i]
          if (a > top) top = a
        }
        if (top === -Infinity) {
          // No particle can explain this step: leave its observations out rather than stop.
          collapses.push({ filter: r, step: t })
          f.logZ = -Infinity
        } else {
          let total = 0
          for (let i = 0; i < N; i++) {
            const w = f.weights[i] > 0 ? Math.exp(Math.log(f.weights[i]) + f.ll[i] - top) : 0
            f.weights[i] = w
            total += w
          }
          for (let i = 0; i < N; i++) f.weights[i] /= total
          f.logZ += top + Math.log(total)
        }
        let sumSq = 0
        for (let i = 0; i < N; i++) sumSq += f.weights[i] * f.weights[i]
        const ess = 1 / sumSq
        essNow.push(ess)
        if (ess < f.essMin) f.essMin = ess
      }
      if (recorded(t)) record(t, essNow)
      // Resample after recording, and never after the last step: the final estimates use the weights.
      if (t < T) {
        for (const [r, f] of filters.entries()) {
          if (essNow[r] >= plan.threshold * N) continue
          resample(plan.resample, f.weights, f.shuffle, f.ancestors)
          for (let i = 0; i < N; i++) f.spare.set(f.rows.subarray(f.ancestors[i] * size, (f.ancestors[i] + 1) * size), i * size)
          const swap = f.rows
          f.rows = f.spare
          f.spare = swap
          f.weights.fill(1 / N)
          f.resampled++
        }
      }
    }

    const replicates: Sample[] = filters.map((f) => ({
      columns: new Map(kept.map((k) => [k.name, Float64Array.from({ length: N }, (_, i) => f.rows[i * size + k.slot])])),
      weights: Float64Array.from(f.weights),
    }))
    const essMin = Math.min(...filters.map((f) => f.essMin))
    const resampled = filters.reduce((s, f) => s + f.resampled, 0) / R
    const numbers: MethodNumber[] = []
    const checks: Check[] = []
    if (observed) {
      const logZ = filters.map((f) => f.logZ)
      const spread = logZ.every(Number.isFinite) ? sampleSd(logZ) : NaN
      numbers.push(
        { key: 'loglik', value: logMeanExp(logZ), mcse: spread / Math.sqrt(R), meaning: 'log-likelihood of the observations, estimated by the filters' },
        { key: 'ess_min', value: essMin, mcse: null, meaning: `lowest effective sample size of a filter, of ${N} particles`, count: true },
        { key: 'resampled', value: resampled, mcse: null, meaning: 'steps at which a filter resampled, on average', count: true },
      )
      checks.push({ name: 'effective sample size', ok: essMin >= 0.1 * N, detail: `the lowest effective sample size was ${Math.round(essMin)} of ${N} particles${essMin < 0.1 * N ? '; the weights degenerate, and more particles would steady the estimates' : ''}` })
      checks.push({ name: 'log-likelihood', ok: spread <= 1, detail: Number.isFinite(spread) ? `the filters' log-likelihoods have a standard deviation of ${spread.toFixed(2)}${spread > 1 ? '; above 1 the likelihood estimate is noisy, and more particles would steady it' : ''}` : 'a filter lost every particle, so the log-likelihood is not finite' })
    }
    if (collapses.length) {
      const steps = [...new Set(collapses.map((c) => c.step))]
      checks.push({ name: 'collapse', ok: false, detail: `every particle lost its weight at step${steps.length > 1 ? 's' : ''} ${steps.slice(0, 8).join(', ')}${steps.length > 8 ? ', …' : ''} in ${new Set(collapses.map((c) => c.filter)).size} of ${R} filters, because no particle could explain the observations or no state was a finite number; there the filter kept its weights from the step before` })
    }
    if (killed) checks.push({ name: 'finite states', ok: false, detail: `${killed} particle-steps gave a state that is not a finite number (such as a draw with arguments outside its distribution) and lost their weight` })
    return {
      replicates,
      size: { particles: N, replicates: R, steps: T },
      steps: series,
      numbers,
      diagnostics: { logliks: observed ? filters.map((f) => f.logZ) : null, resampled: filters.map((f) => f.resampled), collapses },
      checks,
    }
  },
}
