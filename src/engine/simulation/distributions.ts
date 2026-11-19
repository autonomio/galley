// The distributions a simulation may draw from. Every draw is inverse-transform sampling: a
// uniform number goes through the distribution's quantile function. That one rule lets a method
// decide where the uniforms come from (independent, correlated through a copula, stratified)
// while each input keeps exactly the distribution it was given. The log density serves the
// observation likelihoods of the sequential method.
import { betaI, betaQuantile, gammaQ, gammaQuantile, lbeta, lgamma, normalCdf, normalQuantile } from './special.js'

type Args = ArrayLike<number>

export interface Distribution {
  /** Its parameters in the order a call gives them; a variadic one repeats its last. */
  params: readonly string[]
  variadic?: boolean
  discrete: boolean
  about: string
  /** What is wrong with these arguments, or null when they are valid. */
  invalid(p: Args, n: number): string | null
  /** The value at probability u in (0, 1). */
  quantile(u: number, p: Args, n: number): number
  /** ln of the density (or of the mass, when discrete) at x. */
  logpdf(x: number, p: Args, n: number): number
}

const LN_SQRT_2PI = 0.5 * Math.log(2 * Math.PI)
const finite = Number.isFinite
const positive = (x: number) => x > 0 && x < Infinity
const whole = (x: number) => Number.isInteger(x) && x >= 0
const need = (ok: boolean, why: string) => (ok ? null : why)

/** The smallest k with F(k) ≥ u, stepping from a nearby start with the mass function. */
function discreteQuantile(u: number, start: number, top: number, cdf: (k: number) => number, pmf: (k: number) => number): number {
  let k = Math.min(top, Math.max(0, Math.floor(start)))
  let F = cdf(k)
  if (F >= u) {
    while (k > 0) {
      const below = F - pmf(k)
      if (below < u) break
      F = below
      k--
    }
    return k
  }
  for (let steps = 0; k < top && F < u && steps < 1e7; steps++) {
    const mass = pmf(++k)
    F += mass
    // Past the bulk the mass underflows; rounding may leave F a hair below u forever.
    if (mass === 0 && k > start) break
  }
  return k
}

/** A standard normal cut to [a, b], mirrored into the lower tail where Φ keeps its digits. */
function cutNormalQuantile(u: number, a: number, b: number): number {
  if (a > 0) return -cutNormalQuantile(1 - u, -b, -a)
  const lo = normalCdf(a)
  return Math.min(b, Math.max(a, normalQuantile(lo + u * (normalCdf(b) - lo))))
}
const cutNormalMass = (a: number, b: number) => (a > 0 ? normalCdf(-a) - normalCdf(-b) : normalCdf(b) - normalCdf(a))

const below = (lo: number, hi: number) => need(finite(lo) && finite(hi) && lo < hi, 'its min must be below its max')
const withMode = (p: Args) => below(p[0], p[2]) ?? need(p[1] >= p[0] && p[1] <= p[2], 'its mode must lie between its min and its max')
const pertShape = (p: Args): [number, number] => [1 + (4 * (p[1] - p[0])) / (p[2] - p[0]), 1 + (4 * (p[2] - p[1])) / (p[2] - p[0])]
const lchoose = (n: number, k: number) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)

export const DISTRIBUTIONS: ReadonlyMap<string, Distribution> = new Map<string, Distribution>([
  ['normal', {
    params: ['mean', 'sd'], discrete: false, about: 'normal (Gaussian)',
    invalid: (p) => need(finite(p[0]), 'its mean must be a number') ?? need(positive(p[1]), 'its sd must be above 0'),
    quantile: (u, p) => p[0] + p[1] * normalQuantile(u),
    logpdf: (x, p) => { const z = (x - p[0]) / p[1]; return -0.5 * z * z - Math.log(p[1]) - LN_SQRT_2PI },
  }],
  ['lognormal', {
    params: ['meanlog', 'sdlog'], discrete: false, about: 'its logarithm is normal(meanlog, sdlog); the median is exp(meanlog)',
    invalid: (p) => need(finite(p[0]), 'its meanlog must be a number') ?? need(positive(p[1]), 'its sdlog must be above 0'),
    quantile: (u, p) => Math.exp(p[0] + p[1] * normalQuantile(u)),
    logpdf: (x, p) => { if (!(x > 0)) return -Infinity; const z = (Math.log(x) - p[0]) / p[1]; return -0.5 * z * z - Math.log(p[1] * x) - LN_SQRT_2PI },
  }],
  ['uniform', {
    params: ['min', 'max'], discrete: false, about: 'every value between min and max equally likely',
    invalid: (p) => below(p[0], p[1]),
    quantile: (u, p) => p[0] + u * (p[1] - p[0]),
    logpdf: (x, p) => (x >= p[0] && x <= p[1] ? -Math.log(p[1] - p[0]) : -Infinity),
  }],
  ['triangular', {
    params: ['min', 'mode', 'max'], discrete: false, about: 'a triangle from min through its most likely value to max',
    invalid: withMode,
    quantile: (u, p) => {
      const a = p[0], c = p[1], b = p[2]
      return u < (c - a) / (b - a) ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c))
    },
    logpdf: (x, p) => {
      const a = p[0], c = p[1], b = p[2]
      return x < a || x > b ? -Infinity : Math.log((2 * (x < c ? x - a : b - x)) / ((b - a) * (x < c ? c - a : b - c)))
    },
  }],
  ['pert', {
    params: ['min', 'mode', 'max'], discrete: false, about: 'a smooth beta between min and max, peaked at its most likely value (PERT)',
    invalid: withMode,
    quantile: (u, p) => { const [a, b] = pertShape(p); return p[0] + (p[2] - p[0]) * betaQuantile(u, a, b) },
    logpdf: (x, p) => {
      const y = (x - p[0]) / (p[2] - p[0])
      if (!(y > 0 && y < 1)) return -Infinity
      const [a, b] = pertShape(p)
      return (a - 1) * Math.log(y) + (b - 1) * Math.log1p(-y) - lbeta(a, b) - Math.log(p[2] - p[0])
    },
  }],
  ['truncnormal', {
    params: ['mean', 'sd', 'min', 'max'], discrete: false, about: 'normal(mean, sd) cut to [min, max], drawn through its inverse, never clipped; min and max may be -inf and inf',
    invalid: (p) => need(finite(p[0]), 'its mean must be a number') ?? need(positive(p[1]), 'its sd must be above 0')
      ?? need(p[2] < p[3], 'its min must be below its max') ?? need(cutNormalMass((p[2] - p[0]) / p[1], (p[3] - p[0]) / p[1]) > 0, 'its range holds no probability'),
    quantile: (u, p) => p[0] + p[1] * cutNormalQuantile(u, (p[2] - p[0]) / p[1], (p[3] - p[0]) / p[1]),
    logpdf: (x, p) => {
      if (x < p[2] || x > p[3]) return -Infinity
      const z = (x - p[0]) / p[1]
      return -0.5 * z * z - Math.log(p[1]) - LN_SQRT_2PI - Math.log(cutNormalMass((p[2] - p[0]) / p[1], (p[3] - p[0]) / p[1]))
    },
  }],
  ['exponential', {
    params: ['rate'], discrete: false, about: 'waiting times; its mean is 1/rate',
    invalid: (p) => need(positive(p[0]), 'its rate must be above 0'),
    quantile: (u, p) => -Math.log1p(-u) / p[0],
    logpdf: (x, p) => (x >= 0 ? Math.log(p[0]) - p[0] * x : -Infinity),
  }],
  ['gamma', {
    params: ['shape', 'rate'], discrete: false, about: 'its mean is shape/rate (rate = 1/scale)',
    invalid: (p) => need(positive(p[0]), 'its shape must be above 0') ?? need(positive(p[1]), 'its rate must be above 0'),
    quantile: (u, p) => gammaQuantile(u, p[0]) / p[1],
    logpdf: (x, p) => (x > 0 ? p[0] * Math.log(p[1]) + (p[0] - 1) * Math.log(x) - p[1] * x - lgamma(p[0]) : -Infinity),
  }],
  ['beta', {
    params: ['alpha', 'beta'], discrete: false, about: 'a share between 0 and 1; its mean is alpha/(alpha+beta)',
    invalid: (p) => need(positive(p[0]), 'its alpha must be above 0') ?? need(positive(p[1]), 'its beta must be above 0'),
    quantile: (u, p) => betaQuantile(u, p[0], p[1]),
    logpdf: (x, p) => (x > 0 && x < 1 ? (p[0] - 1) * Math.log(x) + (p[1] - 1) * Math.log1p(-x) - lbeta(p[0], p[1]) : -Infinity),
  }],
  ['weibull', {
    params: ['shape', 'scale'], discrete: false, about: 'lifetimes; shape above 1 means wear-out',
    invalid: (p) => need(positive(p[0]), 'its shape must be above 0') ?? need(positive(p[1]), 'its scale must be above 0'),
    quantile: (u, p) => p[1] * (-Math.log1p(-u)) ** (1 / p[0]),
    logpdf: (x, p) => (x >= 0 ? Math.log(p[0] / p[1]) + (p[0] - 1) * Math.log(x / p[1]) - (x / p[1]) ** p[0] : -Infinity),
  }],
  ['bernoulli', {
    params: ['p'], discrete: true, about: '1 with probability p, otherwise 0',
    invalid: (p) => need(p[0] >= 0 && p[0] <= 1, 'its p must be between 0 and 1'),
    quantile: (u, p) => (u > 1 - p[0] ? 1 : 0),
    logpdf: (x, p) => (x === 1 ? Math.log(p[0]) : x === 0 ? Math.log1p(-p[0]) : -Infinity),
  }],
  ['binomial', {
    params: ['n', 'p'], discrete: true, about: 'successes in n trials, each with probability p',
    invalid: (p) => need(whole(p[0]) && p[0] <= 1e9, 'its n must be a whole number from 0') ?? need(p[1] >= 0 && p[1] <= 1, 'its p must be between 0 and 1'),
    quantile: (u, p) => {
      const n = p[0], q = p[1]
      if (q === 0 || n === 0) return 0
      if (q === 1) return n
      const z = normalQuantile(u)
      const pmf = (k: number) => Math.exp(lchoose(n, k) + k * Math.log(q) + (n - k) * Math.log1p(-q))
      return discreteQuantile(u, n * q + z * Math.sqrt(n * q * (1 - q)) + ((z * z - 1) * (1 - 2 * q)) / 6, n, (k) => (k >= n ? 1 : betaI(1 - q, n - k, k + 1)), pmf)
    },
    logpdf: (x, p) => {
      const n = p[0], q = p[1]
      if (!whole(x) || x > n) return -Infinity
      return lchoose(n, x) + (x === 0 ? 0 : x * Math.log(q)) + (x === n ? 0 : (n - x) * Math.log1p(-q))
    },
  }],
  ['poisson', {
    params: ['rate'], discrete: true, about: 'counts of events that occur at this mean rate',
    invalid: (p) => need(p[0] >= 0 && p[0] <= 1e9, 'its rate must be 0 or above'),
    quantile: (u, p) => {
      const rate = p[0]
      if (rate === 0) return 0
      const z = normalQuantile(u)
      const pmf = (k: number) => Math.exp(k * Math.log(rate) - rate - lgamma(k + 1))
      return discreteQuantile(u, rate + z * Math.sqrt(rate) + (z * z - 1) / 6, Infinity, (k) => gammaQ(k + 1, rate), pmf)
    },
    logpdf: (x, p) => (whole(x) ? (x === 0 ? 0 : x * Math.log(p[0])) - p[0] - lgamma(x + 1) : -Infinity),
  }],
  ['categorical', {
    params: ['weight'], variadic: true, discrete: true, about: 'one of 1, 2, … k, with probabilities proportional to the weights',
    invalid: (p, n) => {
      if (n < 2) return 'it needs two weights or more'
      let sum = 0
      for (let i = 0; i < n; i++) {
        if (!(p[i] >= 0 && p[i] < Infinity)) return 'its weights must be 0 or above'
        sum += p[i]
      }
      return need(sum > 0, 'its weights must not all be 0')
    },
    quantile: (u, p, n) => {
      let sum = 0
      for (let i = 0; i < n; i++) sum += p[i]
      const target = u * sum
      let cum = 0
      // Strictly above: a category of weight 0 is never chosen.
      for (let i = 0; i < n; i++) if ((cum += p[i]) > target) return i + 1
      return n
    },
    logpdf: (x, p, n) => {
      if (!Number.isInteger(x) || x < 1 || x > n) return -Infinity
      let sum = 0
      for (let i = 0; i < n; i++) sum += p[i]
      return Math.log(p[x - 1] / sum)
    },
  }],
])
