// Galley's simulation engine: a declarative spec a model writes goes in, a deterministic run on
// this machine comes out as named numbers a paper cites, each with its Monte Carlo error and the
// run's provenance. See docs/SIMULATION.md.
export { DEFAULT_SEED, ENGINE, prepare, simulate, validate } from './core.js'
export { atPrecision, citable, placeholders, type Citable } from './cite.js'
export { specGuide } from './guide.js'
export { readSpec, specSchema } from './spec.js'
export { METHODS } from './methods/index.js'
export { DISTRIBUTIONS } from './distributions.js'
export { FUNCTIONS } from './expression.js'
export type {
  Check, Draws, EventSummary, Method, MethodNumber, Outcome, Problem, Provenance, RunContext, Sample, SequentialSpec, SimulationResult, SimulationSpec, StepSeries, Summary,
} from './types.js'
