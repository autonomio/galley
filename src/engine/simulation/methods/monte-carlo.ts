// Plain Monte Carlo: every input drawn on its own, the model evaluated once per draw.
import type { Stream } from '../random.js'
import type { Check, Draws, Method, Model, Problem, RunContext, Sample, SimulationSpec } from '../types.js'

export const DRAWS = { default: 20000, min: 100, max: 200000 }

/** The number of draws a spec asks for, held within bounds; a bound that bites is noted, never refused. */
export function drawCount(spec: SimulationSpec, notes: Check[]): number {
  const asked = spec.draws ?? DRAWS.default
  const draws = Math.min(DRAWS.max, Math.max(DRAWS.min, Math.round(asked)))
  if (draws !== asked) notes.push({ name: 'draws', ok: false, detail: `${asked} draws were asked for; the run used ${draws}, the nearest the engine allows (${DRAWS.min} to ${DRAWS.max})` })
  return draws
}

/** The parts of a spec a method other than the sequential one cannot use. */
export function noSequence(spec: SimulationSpec, method: string, problems: Problem[]) {
  if (spec.sequential) problems.push({ at: 'sequential', message: `a sequence of states needs method "sequential"; method "${method}" would leave it out` })
}

/**
 * Runs `draws` draws: `fill` gives the inputs their values in env, the model derives the rest, and
 * every output and event is kept per draw.
 */
export function runDraws(draws: number, model: Model, fill: (env: Float64Array) => void): Sample {
  const env = new Float64Array(model.size)
  for (const input of model.inputs) if (!input.draw) env[input.slot] = input.value
  const kept = [...model.outputs, ...model.events]
  const columns = new Map(kept.map((k) => [k.name, new Float64Array(draws)]))
  const sinks = kept.map((k) => ({ slot: k.slot, column: columns.get(k.name)! }))
  for (let i = 0; i < draws; i++) {
    fill(env)
    model.derive(env)
    for (const sink of sinks) sink.column[i] = env[sink.slot]
  }
  return { columns, weights: null }
}

/** The stream an input draws from: named by the input, so its draws never depend on the others. */
export const inputStream = (ctx: RunContext, name: string): Stream => ctx.stream('input', name)

export const monteCarlo: Method<{ draws: number }> = {
  name: 'monte_carlo',
  about: 'independent draws of every input, the model evaluated once per draw',
  prepare(spec, _model, problems, notes) {
    if (spec.correlations.length) problems.push({ at: 'correlations', message: 'correlations need method "correlated"; method "monte_carlo" draws every input on its own' })
    noSequence(spec, 'monte_carlo', problems)
    return { draws: drawCount(spec, notes) }
  },
  run(plan, model, ctx): Draws {
    const random = model.inputs.filter((x) => x.draw).map((x) => ({ slot: x.slot, dist: x.draw!.dist, args: x.args, n: x.args.length, stream: inputStream(ctx, x.name) }))
    const sample = runDraws(plan.draws, model, (env) => {
      for (const r of random) env[r.slot] = r.dist.quantile(r.stream.next(), r.args, r.n)
    })
    return { replicates: [sample], size: { draws: plan.draws, replicates: 1 }, checks: [] }
  },
}
