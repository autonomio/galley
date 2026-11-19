# Simulations

`src/engine/simulation/` runs Monte Carlo simulations for papers. A model writes a spec, which is
plain JSON. Galley runs the spec on this machine, and the run comes back as named numbers. The
paper cites each number by its placeholder, such as `{{sim.S1.profit.p95}}`, so a model never
types a simulated figure. One core serves three methods: plain, correlated and sequential Monte
Carlo. The module is pure TypeScript with no runtime dependencies, and it never calls a model.

```ts
import { simulate, placeholders, specSchema, specGuide } from './simulation/index.js'

const out = simulate(spec)       // never throws over a spec
if (!out.ok) out.problems        // [{ at: 'inputs[1].dist', message: 'gamma has no parameter scale; …' }]
else placeholders(out.result)    // { 'sim.S1.profit.p95': '18,200', 'sim.S1.loss.p': '12.4%', … }
```

| Export | What it is |
| --- | --- |
| `simulate(spec)` | Reads, checks and runs a spec: `{ ok: true, result }` or `{ ok: false, problems }` |
| `validate(spec)` | The problems alone, without running; `[]` when it can run |
| `specSchema` | The spec as JSON Schema in the strict dialect of `src/engine/schema.ts`, for a model's reply |
| `specGuide()` | The format in a few lines for a prompt, generated from the engine's own tables |
| `citable(result)` | Every citable number: `{ key, value, number, meaning }` |
| `placeholders(result)` | The same as `key → value`, ready to spread into the paper's record |
| `METHODS`, `DISTRIBUTIONS`, `FUNCTIONS` | The tables the core, the schema and the guide read |

## The spec

```json
{
  "id": "S1",
  "title": "Profit of the first year",
  "method": "monte_carlo",
  "seed": null,
  "draws": null,
  "inputs": [
    { "name": "price", "dist": "triangular(8, 10, 14)" },
    { "name": "volume", "dist": "lognormal(meanlog = 7, sdlog = 0.3)" },
    { "name": "fixed", "dist": "4000" }
  ],
  "model": [
    { "name": "profit", "expr": "revenue - fixed" },
    { "name": "revenue", "expr": "price * volume" }
  ],
  "outputs": ["profit", "revenue"],
  "events": [{ "name": "loss", "when": "profit < 0" }],
  "correlations": [],
  "sequential": null
}
```

Every field is present. An optional field is null, and a list with nothing in it is `[]`. That
is the strict dialect every provider accepts. When a person writes a spec, a missing optional
field reads as null, and a number where text belongs reads as text.

| Field | Meaning |
| --- | --- |
| `id` | Names the results: `{{sim.<id>.<name>.<stat>}}`. A letter, then letters, digits and `_` |
| `title` | What is simulated, in one sentence |
| `method` | `monte_carlo`, `correlated` or `sequential` |
| `seed` | A whole number from 0 to 4294967295; null for 1 |
| `draws` | Draws for `monte_carlo` and `correlated`; null for 20,000 |
| `inputs` | `[{name, dist}]`. `dist` is a distribution whose arguments are numbers, or one fixed value |
| `model` | `[{name, expr}]`: quantities computed from inputs, states and each other, in any order; a loop is a problem |
| `outputs` | Names of inputs, states or model lines to report |
| `events` | `[{name, when}]`: a condition on one draw; its probability is reported |
| `correlations` | `[{a, b, rho}]`: rank correlations between drawn inputs, for `correlated` |
| `sequential` | The state-space model, for `sequential` (see below); null otherwise |

Names are shared by inputs, states, model lines and events. Names are unique regardless of case,
and the language's own words are reserved: its functions, distributions and constants, `t`, and
the run-level keys (`draws`, `seed`, `particles`, `replicates`, `steps`, `ess_min`, `resampled`,
`loglik`, `loglik_mcse`).

### Expressions

Expressions are data. A tokenizer and parser in `expression.ts` build a tree, and the tree
compiles to closures over one slot array. A name is a slot or an entry in a fixed table; anything
else is a problem. Nothing a model writes reaches `eval` or `Function`, and a test keeps it that
way.

- Numbers (`12`, `0.5`, `3e-4`), names, brackets.
- `+ - * /` and `^` (also `**`), which is right-associative: `-x^2` is `-(x^2)`, and `2^-1` is a half.
- Comparisons `< <= > >= == !=` give 1 or 0. They do not chain; `=` alone only names an argument.
- `and`, `or`, `not` (also `&& || !`).
- Constants `pi`, `e`, `inf`.
- Functions: `if(c, a, b)`, `pick(i, a, b, …)`, `min`, `max`, `abs`, `sqrt`, `exp`, `log`
  (natural), `log10`, `pow`, `floor`, `ceil`, `round`, `clamp(x, lo, hi)`, `logistic`, `logit`,
  `normcdf`, `sin`, `cos`, `tan`, `atan`.
- A NaN stays NaN through comparisons, conditions and logic, so an undefined value is never read as
  false.

A distribution is a value only where a field draws: an input's `dist`, a state's `init` or `next`,
or an observation's `likelihood`. Inside an expression it is a problem. Arguments may be named,
which settles parameterizations: `gamma(shape = 2, rate = 0.5)`.

### Distributions

| Call | Notes |
| --- | --- |
| `normal(mean, sd)` | |
| `lognormal(meanlog, sdlog)` | Its logarithm is normal; the median is `exp(meanlog)` |
| `uniform(min, max)` | |
| `triangular(min, mode, max)` | |
| `pert(min, mode, max)` | Beta-PERT: a smooth beta peaked at the mode |
| `truncnormal(mean, sd, min, max)` | Cut to `[min, max]` through the inverse CDF, never clipped; bounds may be `-inf`, `inf` |
| `exponential(rate)` | Mean `1/rate` |
| `gamma(shape, rate)` | Mean `shape/rate`; `rate = 1/scale` |
| `beta(alpha, beta)` | |
| `weibull(shape, scale)` | |
| `bernoulli(p)` | 1 or 0 |
| `binomial(n, p)` | |
| `poisson(rate)` | |
| `categorical(w1, w2, …)` | 1, 2, … k with probabilities proportional to the weights |

Every draw is inverse-transform sampling: a uniform number goes through the distribution's
quantile function. The normal quantile is Wichura's AS 241. The normal CDF is Hart's algorithm
within three sd and the incomplete gamma's continued fraction beyond, both to about 1e-15. Gamma,
beta and PERT quantiles invert their incomplete functions by safeguarded Newton steps. Discrete
quantiles step from a Cornish–Fisher start. The log densities give the sequential method its
likelihoods.

## The methods

A method only decides how values are drawn. The core reads and checks the spec, compiles the model
and summarizes the draws the same way for every method.

### `monte_carlo`

Every input is drawn on its own, from its own stream, and the model runs once per draw.

### `correlated`

This method is a Gaussian copula. Each correlated input's uniform becomes a normal score. The
Cholesky factor of the score correlation matrix mixes the scores, and each mixed score goes back
through Φ and the input's own quantile function. Dependence changes; no input's distribution
does.

A spec states rank (Spearman) correlations ρ, which do not depend on the marginals, so a run
recovers the stated value whatever the inputs' distributions. The scores use r = 2 sin(πρ/6).
Inputs outside every pair draw exactly as in `monte_carlo`. A run reports the rank correlation it
achieved for every stated pair. Ties in a discrete input weaken a rank correlation, and the check
says so.

Correlations that cannot hold together still run. The run uses the nearest correlation matrix
(Higham's alternating projections), and a check states how far a correlation moved.

### `sequential`

This method is a bootstrap particle filter over a state-space model:

```json
"sequential": {
  "states": [{ "name": "level", "init": "normal(0, 1)", "next": "normal(0.9 * level, sigma)" }],
  "observations": [{ "name": "y", "values": [0.4, null, 1.1], "likelihood": "normal(level, 0.8)" }],
  "steps": null, "particles": null, "replicates": null, "resample": "systematic", "threshold": null
}
```

- **Start, at t = 0.** Each particle draws the inputs once; they act as its fixed parameters. Then
  each state takes its `init`, which may read the inputs and the states listed before it.
- **Each step, t = 1, 2, ….** States take their `next` in the listed order, so a name reads its
  newest value, as in lines of code. A `next` may be a distribution or a plain expression; an
  expression makes the state deterministic, such as an accumulator `max(peak, x)`. Model lines keep
  the previous step's values until the states have moved, then are computed again.
- **Weighting.** Each observed value multiplies a particle's weight by its likelihood. A null value
  is a step with nothing observed.
- **Resampling.** When the effective sample size falls below `threshold` × particles (default 0.5),
  the particles are resampled: `systematic` (default), `stratified` or `multinomial`. Never after the
  last step, because the final estimates use the weights.
- **Without observations.** Weights stay equal, and the filter is a forward simulation of the states
  over `steps` steps.

`replicates` independent filters (default 8, of `particles` each, default 1,000) run in lockstep.
They are pooled for the estimates, and the spread between them gives every estimate its Monte Carlo
error. Resampling makes one filter's particles depend on each other, which a single-filter formula
would miss.

Outputs and events describe the last step. `loglik` is the log of the mean of the filters'
likelihood estimates. `ess_min` is the lowest effective sample size a filter reached, and
`resampled` is the number of steps at which a filter resampled, on average.

A particle whose state is not a finite number loses its weight, such as one drawn from arguments
outside its distribution. A step whose observations no particle can explain is left out in that
filter. Both are checks, never a stop. Inputs drawn per particle are not refreshed, so under many
resamplings they collapse onto few values. That is the known limit of static parameters in a
bootstrap filter.

## Randomness

The generator is xoshiro128** (period 2¹²⁸ − 1), seeded by splitmix32, and its uniforms carry 53
bits. Every random quantity draws from a stream of its own, named by what it draws:
`('input', name)`, or `('sequential', replicate, 'next', state)`. A draw therefore depends only on
the seed, the stream's name and its place in the stream:

- adding, removing or reordering an input moves no other input's draws;
- two simulations with one seed share the draws of inputs with the same name (common random
  numbers), so a difference between scenarios is the model's, not noise.

The same spec and seed give the same numbers on the same JavaScript engine. Across engines,
`Math.exp` and `Math.log` may differ in the last digit.

## Results

`simulate` returns a `SimulationResult`:

| Field | Holds |
| --- | --- |
| `outputs[name]` | `n`, `nonfinite`, `mean`, `sd`, `p5`, `p50`, `p95`, and `mcse` of each |
| `events[name]` | `p`, `mcse`, `hits` (samples in which it held), `n`, `nonfinite` |
| `numbers` | Method-level numbers: `loglik` (with its MCSE), `ess_min` and `resampled` for `sequential` |
| `series.histograms[name]` | 30 bins over the central 99% of the weight; the tails are counted apart (`below`, `above`), never folded into the edge bins |
| `series.cdfs[name]` | The quantile at 41 probabilities from 0 to 1 |
| `series.steps` | `sequential` only: `t`, mean ESS per step, and per output its mean, p5, p50 and p95 at every step (at most about 100 points) |
| `diagnostics` | `correlated`: stated, used and achieved rank correlations. `sequential`: each filter's log-likelihood, resamplings and collapses |
| `provenance` | `engine`, `method`, `seed`, `size` (draws, or particles, replicates and steps), `fingerprint` of the spec, `runtimeMs`, `checks`, `ok` |
| `spec` | The spec as it ran, the seed filled in: with it every number can be reproduced |

Quantiles interpolate between the midpoints of each value's share of the weight (Hazen's rule
when the weights are equal). A value that is not finite, such as a division by zero, is left out
of its summary and counted in `nonfinite`.

### Monte Carlo error

- **One replicate of equal-weight draws** (`monte_carlo`, `correlated`): the mean's error is
  sd/√n; the sd's comes from the delta method on the fourth moment. A quantile's error is half the
  width of ±1 standard error of its rank, mapped to values, and a probability's is √(p(1 − p)/n).
- **Independent replicates** (`sequential`): every statistic's error is the standard deviation of
  its replicate estimates over √R.

### Checks

A check is a note on the run, `{ name, ok, detail }`. It never stops a run.
`provenance.ok` says whether every check passed.

- **Precision of an output:** the mean's MCSE is within 1% of max(|mean|, sd).
- **Precision of an event:** its probability's MCSE is within 0.5 percentage points. An event that
  never or always held says so.
- **Finite values:** how many samples were left out.
- **Correlations:** each achieved rank correlation is within 0.03 of what ran, and a repair says how
  far it moved.
- **Sequential runs:** the lowest ESS stays at or above a tenth of the particles; the filters'
  log-likelihoods have an sd at most 1; and the check reports any collapse or non-finite state.
- **Bounds:** draws, particles or a threshold beyond what the engine allows are held to the nearest
  allowed value, and the check says so.

### Placeholders

`citable(result)` lists every number a paper may cite:

| Key | Value |
| --- | --- |
| `sim.S1.<output>.mean`, `.sd`, `.p5`, `.p50`, `.p95` | The statistic |
| `sim.S1.<output>.mcse` | The MCSE of its mean |
| `sim.S1.<event>.p` | Its probability as a percentage, such as `12.4%` |
| `sim.S1.<event>.mcse` | Its MCSE in percentage points |
| `sim.S1.seed`, `.draws` | The run's seed and draws |
| `sim.S1.particles`, `.replicates`, `.steps` | The size of a sequential run |
| `sim.S1.loglik`, `.loglik_mcse`, `.ess_min`, `.resampled` | A sequential run's method-level numbers |

Each value is written to the precision its MCSE supports: down to the decimal place of the
error's leading digit, and never beyond four significant digits. For example, 12,436.27 with an
error of 41 reads `12,440`. A value with no error, such as a fixed quantity, keeps four
significant digits. Thousands get separators from 10,000 on, so a year reads `2015`.

An event that never held reads as a bound, `< 0.02%` for 20,000 draws, from the rule of three
(3/n). One that always held reads `> 99.98%`.

## Adding a method

A method is one object implementing `Method` from `types.ts`:

```ts
export interface Method<Plan> {
  name: string                      // the value of `method` in a spec
  about: string                     // one sentence for the guide
  scope?(spec): { name, at, system? }[]   // names it adds to what expressions read, as `sequential` adds its states and t
  prepare(spec, model, problems, notes): Plan   // check its own part of the spec; push problems (stop) or notes (report)
  run(plan, model, ctx): Draws      // draw, and return independent replicates of (weighted) samples
}
```

`run` gets the compiled `Model`, which holds the inputs with their distributions and arguments,
`derive(env)` for the model lines and events, and the slot of every name. It also gets a `ctx`
whose `stream(...labels)` hands out named streams. It returns `replicates`: for each, a column per
output and event, with `weights` (summing to 1) or null for equal weights. It may also return
`numbers`, `steps`, `diagnostics` and `checks`. The core computes everything else: statistics,
errors, histograms, CDFs, checks on precision, citations and provenance.

To add one:

1. Write `methods/<name>.ts`. Reuse `runDraws` and `inputStream` from `methods/monte-carlo.ts` when
   draws are independent; a Latin hypercube, say, only changes where each input's uniforms come
   from.
2. Add it to the list in `methods/index.ts`. The schema's `method` enum, the guide and `validate`
   pick it up from there.
3. Add a test in `tests/unit/simulation.test.ts` against something known exactly, and a section here.

A distribution is one entry in `DISTRIBUTIONS` (`distributions.ts`): its parameters, `invalid`,
`quantile` and `logpdf`. A function is one entry in `FUNCTIONS` (`expression.ts`). The guide and
the reserved names follow both tables.

## Limits

| | Default | Allowed |
| --- | --- | --- |
| Draws | 20,000 | 100 to 200,000 |
| Particles per filter | 1,000 | 50 to 50,000 |
| Replicates | 8 | 2 to 32 |
| Steps | — | up to 10,000; particles × replicates × steps up to 2 × 10⁷, otherwise fewer particles, noted |

A spec holds up to 64 inputs, 64 model lines, 16 outputs, 16 events, 32 states and 8 observed
series. Draws, particles and replicates beyond their bounds are held to them with a note; going
past a structural limit is a problem.

## In a paper

When a paper asks for a simulation (`--simulation yes`, or the start dialog), the `simulate` behavior runs before the argument is planned: the author writes the specs from `specGuide()` against `specSchema`, with the basis of every input; `simulate` runs each one, and its problems go back to the author until every spec runs. `src/engine/simulations.ts` is the paper's side: the block every prompt reads (model, assumptions, checks, and each citable number under its placeholder), the placeholders the production record fills, and the series a figure may chart. See [Papers](PAPERS.md).

## Not built yet

- Sensitivity indices (Sobol) and Latin hypercube or quasi-Monte Carlo methods: each would be one
  more method.
- Known per-step inputs (covariates) in the sequential method, and rejuvenation of its static
  parameters.
