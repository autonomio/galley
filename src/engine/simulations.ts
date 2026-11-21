// A paper's simulations, as the rest of galley reads them: the block every
// prompt sees, the placeholders the production record fills, and the series a
// figure may chart. The engine itself (simulation/) knows nothing of papers.
import type { Paper } from './paper.js'
import { citable, placeholders } from './simulation/index.js'
import type { SimulationResult } from './simulation/index.js'

/** One simulation the paper runs: the engine's result, and why the author built it so. */
export interface SimulationRun {
  id: string
  title: string
  /** What the simulation shows for the paper, in the author's words. */
  purpose: string
  /** Where each input's distribution comes from. */
  assumptions: { name: string; basis: string }[]
  result: SimulationResult
}

export const runsOf = (paper: Paper): SimulationRun[] => Object.values(paper.state.simulations ?? {})

/** How large a run was, in words: "20,000 draws" or "8 filters of 1,000 particles over 36 steps". */
export function sizeOf(result: SimulationResult): string {
  const size = result.provenance.size
  const n = (x: number | undefined) => (x ?? 0).toLocaleString('en-US')
  return size.particles ? `${n(size.replicates)} filters of ${n(size.particles)} particles over ${n(size.steps)} steps` : `${n(size.draws)} draws`
}

const METHOD_WORDS: Record<string, string> = { monte_carlo: 'Monte Carlo', correlated: 'correlated Monte Carlo (Gaussian copula)', sequential: 'sequential Monte Carlo (bootstrap particle filter)' }
export const methodWords = (method: string) => METHOD_WORDS[method] ?? method

/** The simulations as every prompt sees them: model, assumptions, checks, and each citable number under its placeholder. */
export function simulationsBlock(paper: Paper): string {
  const runs = runsOf(paper)
  if (!runs.length) return ''
  return `SIMULATIONS run on the authors' machine with galley's Monte Carlo engine. A simulated number appears in the text only as its placeholder, such as {{sim.S1.profit.p95}}, filled in when the paper is typeset; never write it as a figure. Wherever a result is used, say what the simulation assumes. The paper states each simulation's model as it is specified below (its inputs with their distributions and the basis of each, its formulas, its events), so a reader can repeat the run as code; what the specification states is stated as the model, never as something a record does or does not show.
${runs.map((run) => {
  const r = run.result
  const failed = r.provenance.checks.filter((c) => !c.ok)
  return `${run.id}: ${run.title.replace(/[.\s]+$/, '')}. Purpose: ${run.purpose}
  Method: ${methodWords(r.method)}, ${sizeOf(r)}, seed ${r.provenance.seed}. Checks: ${failed.length ? failed.map((c) => `${c.name}: ${c.detail}`).join('; ') : 'all passed'}.
  Inputs: ${r.spec.inputs.map((i) => `${i.name} ~ ${i.dist}${run.assumptions.find((a) => a.name === i.name) ? ` (basis: ${run.assumptions.find((a) => a.name === i.name)!.basis})` : ''}`).join('; ') || 'none'}
  Model: ${r.spec.model.map((m) => `${m.name} = ${m.expr}`).join('; ') || 'none'}${r.spec.events.length ? `\n  Events: ${r.spec.events.map((e) => `${e.name}: ${e.when}`).join('; ')}` : ''}${r.spec.correlations.length ? `\n  Rank correlations: ${r.spec.correlations.map((c) => `${c.a}–${c.b} ${c.rho}`).join('; ')}` : ''}
  Results: ${citable(r).map((c) => `{{${c.key}}} = ${c.value} (${c.meaning})`).join('; ')}`
}).join('\n')}`
}

/** Every simulated number, for the production record. */
export function simulationPlaceholders(paper: Paper): Record<string, string> {
  return Object.assign({}, ...runsOf(paper).map((run) => placeholders(run.result)))
}

const round = (x: number) => Number(x.toPrecision(4))

/** What a figure may chart, from the runs themselves: each output's histogram, or a sequential run's bands over time. */
export function simulationSeries(paper: Paper): string {
  const runs = runsOf(paper)
  if (!runs.length) return ''
  return `Simulation results a figure may chart, exactly as the runs produced them:\n${runs.map((run) => {
    const { histograms, steps } = run.result.series
    if (steps) {
      return Object.entries(steps.bands).map(([name, b]) => `${run.id} ${name} over t = ${steps.t.map(round).join(', ')}: mean ${b.mean.map(round).join(', ')}; p5 ${b.p5.map(round).join(', ')}; p95 ${b.p95.map(round).join(', ')}`).join('\n')
    }
    return Object.entries(histograms).map(([name, h]) => `${run.id} ${name} histogram: bin edges ${h.edges.map(round).join(', ')}; share of draws per bin ${h.share.map((x) => round(x)).join(', ')} (below the first edge ${round(h.below)}, above the last ${round(h.above)})`).join('\n')
  }).join('\n')}`
}
