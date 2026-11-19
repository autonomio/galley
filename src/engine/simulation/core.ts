// One core for every method: a spec is read and checked, its model compiled, the method draws, and
// the core summarizes what came back the same way for all methods, with each estimate's Monte
// Carlo error, notes on the run's own quality, and its provenance. Nothing here throws over a
// spec: what keeps one from running comes back as problems, located, with the fix where there is
// one; what only weakens a run comes back as a check beside its numbers.
import { METHODS } from './methods/index.js'
import { compileModel } from './model.js'
import { canonical, fingerprint, stream } from './random.js'
import { readSpec } from './spec.js'
import { describe, describeEvent } from './stats.js'
import type { Check, Cdf, EventSummary, Histogram, Method, Model, Outcome, Problem, RunContext, SimulationResult, SimulationSpec, Summary } from './types.js'

export const ENGINE = 'galley-simulation-1'
export const DEFAULT_SEED = 1
/** A mean is precise enough when its Monte Carlo error is within this share of its scale. */
export const PRECISION = 0.01
/** An event's probability is precise enough within this many percentage points. */
export const EVENT_PRECISION = 0.5

export interface Prepared {
  spec: SimulationSpec
  model: Model
  method: Method
  plan: unknown
  notes: Check[]
}

/** Reads, checks and compiles a spec, ready to run; or every problem that keeps it from running. */
export function prepare(raw: unknown): { ok: true; prepared: Prepared } | { ok: false; problems: Problem[] } {
  const { spec, problems } = readSpec(raw)
  const method = spec && METHODS.get(spec.method)
  if (!spec || !method) return { ok: false, problems }
  const notes: Check[] = []
  const model = compileModel(spec, method.scope?.(spec) ?? [], problems)
  const plan = method.prepare(spec, model, problems, notes)
  return problems.length ? { ok: false, problems } : { ok: true, prepared: { spec, model, method, plan, notes } }
}

/** The problems that keep a spec from running; none when it can run. */
export function validate(raw: unknown): Problem[] {
  const ready = prepare(raw)
  return ready.ok ? [] : ready.problems
}

const share = (x: number) => `${Number((100 * x).toPrecision(2))}%`

function precision(name: string, s: Summary, more: string): Check {
  const label = `precision of ${name}`
  if (!s.n) return { name: label, ok: false, detail: `${name} has no finite value to summarize` }
  const scale = Math.max(Math.abs(s.mean), s.sd)
  if (!(scale > 0)) return { name: label, ok: true, detail: `${name} is 0 in every sample` }
  const error = s.mcse.mean / scale
  return { name: label, ok: error <= PRECISION, detail: `the Monte Carlo standard error of its mean is ${share(error)} of its scale${error > PRECISION ? `; ${more} would sharpen it` : ''}` }
}

function eventPrecision(name: string, e: EventSummary, more: string): Check {
  const label = `precision of ${name}`
  if (!e.n) return { name: label, ok: false, detail: `${name} could not be decided in any sample` }
  if (e.hits === 0 || e.hits === e.n) {
    return { name: label, ok: true, detail: `${name} ${e.hits ? 'held' : 'did not hold'} in every one of ${e.n} samples, so its probability is ${e.hits ? 'above' : 'below'} what the run can resolve` }
  }
  const points = 100 * e.mcse
  return { name: label, ok: points <= EVENT_PRECISION, detail: `the Monte Carlo standard error of its probability is ${Number(points.toPrecision(2))} percentage points${points > EVENT_PRECISION ? `; ${more} would sharpen it` : ''}` }
}

const unfinished = (name: string, nonfinite: number, n: number): Check => ({
  name: `finite values of ${name}`, ok: false,
  detail: `${nonfinite} of ${n + nonfinite} samples of ${name} were not finite numbers (such as a division by 0) and are left out of its summary`,
})

/** Runs a simulation spec. The same spec and seed give the same numbers, on the same JavaScript engine. */
export function simulate(raw: unknown): Outcome {
  const started = performance.now()
  const ready = prepare(raw)
  if (!ready.ok) return ready
  const { spec, model, method, plan, notes } = ready.prepared
  const seed = spec.seed ?? DEFAULT_SEED
  const ctx: RunContext = { seed, stream: (...labels) => stream(seed, ...labels) }
  const draws = method.run(plan, model, ctx)

  const checks = [...notes, ...draws.checks]
  const more = draws.size.particles ? 'more particles' : 'more draws'
  const outputs: Record<string, Summary> = {}
  const histograms: Record<string, Histogram> = {}
  const cdfs: Record<string, Cdf> = {}
  for (const o of model.outputs) {
    const d = describe(draws.replicates.map((r) => ({ values: r.columns.get(o.name)!, weights: r.weights })))
    outputs[o.name] = d.summary
    histograms[o.name] = d.histogram
    cdfs[o.name] = d.cdf
    checks.push(precision(o.name, d.summary, more))
    if (d.summary.nonfinite) checks.push(unfinished(o.name, d.summary.nonfinite, d.summary.n))
  }
  const events: Record<string, EventSummary> = {}
  for (const e of model.events) {
    const s = describeEvent(draws.replicates.map((r) => ({ values: r.columns.get(e.name)!, weights: r.weights })))
    events[e.name] = s
    checks.push(eventPrecision(e.name, s, more))
    if (s.nonfinite) checks.push(unfinished(e.name, s.nonfinite, s.n))
  }

  const ran = { ...spec, seed }
  const result: SimulationResult = {
    id: spec.id,
    title: spec.title,
    method: spec.method,
    outputs,
    events,
    numbers: draws.numbers ?? [],
    series: { histograms, cdfs, steps: draws.steps ?? null },
    diagnostics: draws.diagnostics ?? {},
    provenance: {
      engine: ENGINE,
      method: spec.method,
      seed,
      size: draws.size,
      fingerprint: fingerprint(canonical(ran)),
      runtimeMs: Math.round(performance.now() - started),
      ok: checks.every((c) => c.ok),
      checks,
    },
    spec: ran,
  }
  return { ok: true, result }
}
