// What a model reads before it writes a spec, generated from the engine's own tables, so the
// guide never describes a distribution, function or method the engine does not have.
import { DRAWS } from './methods/monte-carlo.js'
import { PARTICLES, REPLICATES } from './methods/sequential.js'
import { DISTRIBUTIONS } from './distributions.js'
import { FUNCTIONS } from './expression.js'
import { METHODS } from './methods/index.js'
import { DEFAULT_SEED } from './core.js'
import { RESAMPLING } from './spec.js'

const thousands = (n: number) => n.toLocaleString('en-US')

/** The spec format in a few lines, for a prompt. */
export function specGuide(): string {
  const dists = [...DISTRIBUTIONS].map(([name, d]) => `${name}(${d.variadic ? `${d.params[0]}1, ${d.params[0]}2, …` : d.params.join(', ')}): ${d.about}${d.discrete ? ' (whole numbers)' : ''}`)
  const fns = [...FUNCTIONS].map(([name, f]) => (f.about.startsWith(`${name}(`) ? f.about : `${name}: ${f.about}`))
  return [
    'A SIMULATION is one JSON object. Galley runs it on this machine; the paper cites its results only as placeholders, {{sim.<id>.<name>.<stat>}}, and never writes a simulated number as a figure.',
    '- id: a short name such as S1. title: what is simulated, in one sentence.',
    `- method: ${[...METHODS.values()].map((m) => `${m.name} (${m.about})`).join('; ')}.`,
    `- seed: a whole number, or null for ${DEFAULT_SEED}. The same spec and seed give the same numbers; simulations that share a seed share the draws of inputs with the same name, so their differences are not noise.`,
    `- draws: for monte_carlo and correlated, or null for ${thousands(DRAWS.default)}.`,
    '- inputs: [{name, dist}]. dist is a distribution with numbers for arguments, such as triangular(80, 100, 150), or one fixed value. Arguments may be named: gamma(shape = 2, rate = 0.5). The distributions:',
    ...dists.map((d) => `  ${d}`),
    '- model: [{name, expr}]: quantities computed from the inputs, the states and each other, in any order. Expressions use numbers, names, + - * / ^ and brackets; comparisons < <= > >= == != give 1 or 0; and, or, not; the constants pi, e and inf; and the functions:',
    `  ${fns.join('; ')}.`,
    '- outputs: names of inputs, states or model lines to report. Each gets mean, sd, p5, p50, p95 and mcse (the Monte Carlo standard error of its mean): {{sim.S1.profit.p95}}.',
    '- events: [{name, when}]: a condition on one draw, such as profit < 0 and cost > 300. Its probability is {{sim.S1.<name>.p}}, counted draw by draw, never by multiplying probabilities.',
    '- correlations: [{a, b, rho}]: rank (Spearman) correlations between two drawn inputs, for method correlated; [] otherwise. Each input keeps its own distribution.',
    '- sequential: null, or for method sequential {states, observations, steps, particles, replicates, resample, threshold}:',
    '  - states: [{name, init, next}]. init is the state before the first step: a distribution or a value, over the inputs and the states listed before it. next is its value at each step t = 1, 2, …: a distribution or an expression over the inputs, the states, the model lines and t. States update in the listed order, so a name reads its newest value; model lines keep the values of the previous step until the states have moved.',
    '  - observations: [{name, values, likelihood}]: one value per step (null where nothing was observed), and the distribution of one observation given the state, such as normal(level, 0.5). [] for a forward simulation.',
    `  - steps: how many steps when nothing is observed, null otherwise. particles: per filter, null for ${thousands(PARTICLES.default)}. replicates: independent filters, null for ${REPLICATES.default}. resample: ${RESAMPLING.join(', ')}. threshold: resample when the effective sample size falls below this share of the particles, null for 0.5.`,
    '  - Outputs and events describe the last step; {{sim.S1.loglik}} is the log-likelihood of the observations.',
  ].join('\n')
}
