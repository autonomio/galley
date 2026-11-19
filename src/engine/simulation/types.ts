// The shapes a simulation passes through: the spec a model writes, the method interface every
// way of drawing implements, and the result a paper cites.
import type { Fn } from './expression.js'
import type { Distribution } from './distributions.js'
import type { Stream } from './random.js'

/** A simulation as a model writes it: JSON in the strict dialect, every field present, optional ones null. */
export interface SimulationSpec {
  /** Names its results: {{sim.<id>.<name>.<stat>}}. */
  id: string
  title: string
  method: string
  seed: number | null
  /** Draws, for the methods that draw independently; null for the default. */
  draws: number | null
  inputs: { name: string; dist: string }[]
  model: { name: string; expr: string }[]
  outputs: string[]
  events: { name: string; when: string }[]
  /** Rank (Spearman) correlations between inputs, for the correlated method. */
  correlations: { a: string; b: string; rho: number }[]
  sequential: SequentialSpec | null
}

export type Resampling = 'systematic' | 'stratified' | 'multinomial'

export interface SequentialSpec {
  states: { name: string; init: string; next: string }[]
  observations: { name: string; values: (number | null)[]; likelihood: string }[]
  /** Steps to run when nothing is observed; otherwise the observations' length. */
  steps: number | null
  particles: number | null
  replicates: number | null
  resample: Resampling | null
  /** Resample when the effective sample size falls below this share of the particles. */
  threshold: number | null
}

/** Something that keeps a spec from running, where it is: `inputs[2].dist`, or '' for the whole. */
export interface Problem {
  at: string
  message: string
}

/** A note on a run: never a gate, always reported. */
export interface Check {
  name: string
  ok: boolean
  detail: string
}

export interface Draw {
  /** The distribution's name as written. */
  name: string
  dist: Distribution
  /** Its arguments, in parameter order. */
  args: Fn[]
}

export interface Input {
  name: string
  slot: number
  /** Null for a fixed value. */
  draw: Draw | null
  /** The draw's arguments, which are numbers, evaluated once. */
  args: Float64Array
  /** A fixed input's value. */
  value: number
}

/** The shared part of every simulation, compiled once: every method runs this one model. */
export interface Model {
  /** The slot of every name in the array a draw is evaluated in. */
  slots: Map<string, number>
  size: number
  inputs: Input[]
  lines: { name: string; slot: number; fn: Fn }[]
  outputs: { name: string; slot: number }[]
  events: { name: string; slot: number; fn: Fn }[]
  /** Computes every model line, in dependency order, then every event. */
  derive(env: Float64Array): void
}

export interface RunContext {
  seed: number
  stream(...labels: (string | number)[]): Stream
}

/** One independent replicate of a run: each output's and event's value per draw or particle. */
export interface Sample {
  columns: Map<string, Float64Array>
  /** Weights per draw summing to 1, or null when every draw counts the same. */
  weights: Float64Array | null
}

export interface RunSize {
  draws?: number
  particles?: number
  replicates: number
  steps?: number
}

/** A number a method adds to what a paper may cite, such as the sequential method's log-likelihood. */
export interface MethodNumber {
  key: string
  value: number
  mcse: number | null
  meaning: string
  /** A count, shown as a whole number. */
  count?: boolean
}

export interface StepSeries {
  t: number[]
  /** Effective sample size before resampling, averaged over the replicates. */
  ess: number[]
  bands: Record<string, { mean: number[]; p5: number[]; p50: number[]; p95: number[] }>
}

/** What a method's run hands back to the core, which summarizes it the same way for every method. */
export interface Draws {
  replicates: Sample[]
  size: RunSize
  steps?: StepSeries
  numbers?: MethodNumber[]
  diagnostics?: Record<string, unknown>
  checks: Check[]
}

/**
 * A way of drawing. The core validates the shared part of a spec and compiles its model; a
 * method checks its own part, draws, and returns independent replicates of (weighted) samples.
 * The core does the rest: statistics, Monte Carlo errors, citations, provenance.
 */
export interface Method<Plan = unknown> {
  /** The value of `method` in a spec. */
  name: string
  /** One sentence for the guide and the docs. */
  about: string
  /** Names the method adds to what the model, the outputs and the events may read. */
  scope?(spec: SimulationSpec): { name: string; at: string; system?: boolean }[]
  /** Checks and compiles the method's own part; problems stop the run, notes are reported with it. */
  prepare(spec: SimulationSpec, model: Model, problems: Problem[], notes: Check[]): Plan
  run(plan: Plan, model: Model, ctx: RunContext): Draws
}

export interface Summary {
  /** Finite values summarized, over every replicate. */
  n: number
  nonfinite: number
  mean: number
  sd: number
  p5: number
  p50: number
  p95: number
  /** Monte Carlo standard error of each statistic. */
  mcse: { mean: number; sd: number; p5: number; p50: number; p95: number }
}

export interface EventSummary {
  p: number
  mcse: number
  /** Draws or particles in which it happened. */
  hits: number
  n: number
  nonfinite: number
}

export interface Histogram {
  edges: number[]
  /** Share of the weight in each bin; values below the first edge or above the last are counted apart. */
  share: number[]
  below: number
  above: number
}

export interface Cdf {
  p: number[]
  x: number[]
}

export interface Provenance {
  engine: string
  method: string
  seed: number
  size: RunSize
  /** Of the normalized spec: the same spec always has the same fingerprint. */
  fingerprint: string
  /** The JavaScript engine that ran it, such as "node v23.10.0". */
  runtime: string
  runtimeMs: number
  /** Whether every check passed. */
  ok: boolean
  checks: Check[]
}

export interface SimulationResult {
  id: string
  title: string
  method: string
  outputs: Record<string, Summary>
  events: Record<string, EventSummary>
  numbers: MethodNumber[]
  series: { histograms: Record<string, Histogram>; cdfs: Record<string, Cdf>; steps: StepSeries | null }
  diagnostics: Record<string, unknown>
  provenance: Provenance
  /** The spec as it ran, defaults filled in: with the seed it reproduces every number. */
  spec: SimulationSpec
}

export type Outcome = { ok: true; result: SimulationResult } | { ok: false; problems: Problem[] }
