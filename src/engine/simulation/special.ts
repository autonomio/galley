// The special functions the distributions rest on, close to double precision: ln Γ, the normal
// distribution and its inverse, and the regularized incomplete gamma and beta functions with
// their inverses. Their tails set truncation bounds and observation likelihoods, where a
// seven-digit approximation shifts results that are meant to be exact.

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
const LN_SQRT_2PI = 0.5 * Math.log(2 * Math.PI)
const EPS = 1e-15
const TINY = 1e-300

/** ln Γ(x), by the Lanczos approximation (g = 7, nine terms). */
export function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x)
  const y = x - 1
  let a = LANCZOS[0]
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (y + i)
  const t = y + 7.5
  return LN_SQRT_2PI + (y + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Φ(z), the standard normal distribution function. */
export function normalCdf(z: number): number {
  if (z !== z) return NaN
  const x = Math.abs(z)
  let tail: number
  if (x < 3) {
    // Hart's algorithm 5666 as given by West (2005): 1e-14 out to three sd, and fast.
    const n = (((((0.0352624965998911 * x + 0.700383064443688) * x + 6.37396220353165) * x + 33.912866078383) * x + 112.079291497871) * x + 221.213596169931) * x + 220.206867912376
    const d = ((((((0.0883883476483184 * x + 1.75566716318264) * x + 16.064177579207) * x + 86.7807322029461) * x + 296.564248779674) * x + 637.333633378831) * x + 793.826512519948) * x + 440.413735824752
    tail = (Math.exp(-0.5 * x * x) * n) / d
  } else {
    // Beyond three sd Hart's relative error grows to 1e-9; the tail's continued fraction keeps 1e-15.
    tail = 0.5 * gammaQ(0.5, 0.5 * x * x)
  }
  return z > 0 ? 1 - tail : tail
}

/** Φ⁻¹(p), the standard normal quantile: Wichura's AS 241 (PPND16), to about 1e-16. */
export function normalQuantile(p: number): number {
  if (!(p > 0)) return p === 0 ? -Infinity : NaN
  if (!(p < 1)) return p === 1 ? Infinity : NaN
  const q = p - 0.5
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q
    return (q * (((((((2509.0809287301226727 * r + 33430.575583588128105) * r + 67265.770927008700853) * r + 45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r + 133.14166789178437745) * r + 3.387132872796366608)) /
      (((((((5226.495278852545925 * r + 28729.085735721942674) * r + 39307.89580009271061) * r + 21213.794301586595867) * r + 5394.1960214247511077) * r + 687.1870074920579083) * r + 42.313330701600911252) * r + 1)
  }
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p))
  let x: number
  if (r <= 5) {
    r -= 1.6
    x = (((((((7.7454501427834140764e-4 * r + 0.0227238449892691845833) * r + 0.24178072517745061177) * r + 1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r + 4.6303378461565452959) * r + 1.42343711074968357734) /
      (((((((1.05075007164441684324e-9 * r + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r + 0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r + 2.05319162663775882187) * r + 1)
  } else {
    r -= 5
    x = (((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r + 0.026532189526576123093) * r + 0.29656057182850489123) * r + 1.7848265399172913358) * r + 5.4637849111641143699) * r + 6.6579046435011037772) /
      (((((((2.04426310338993978564e-15 * r + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r + 7.868691311456132591e-4) * r + 0.0148753612908506148525) * r + 0.13692988092273580531) * r + 0.59983220655588793769) * r + 1)
  }
  return q < 0 ? -x : x
}

const gammaFront = (a: number, x: number) => Math.exp(a * Math.log(x) - x - lgamma(a))

function gammaSeries(a: number, x: number): number {
  let ap = a
  let term = 1 / a
  let sum = term
  for (let n = 0; n < 100000; n++) {
    ap += 1
    term *= x / ap
    sum += term
    if (Math.abs(term) < Math.abs(sum) * EPS) break
  }
  return sum * gammaFront(a, x)
}

// Modified Lentz evaluation of the continued fraction for Q(a, x).
function gammaFraction(a: number, x: number): number {
  let b = x + 1 - a
  let c = 1 / TINY
  let d = 1 / b
  let h = d
  for (let i = 1; i < 100000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < TINY) d = TINY
    c = b + an / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const step = d * c
    h *= step
    if (Math.abs(step - 1) < EPS) break
  }
  return gammaFront(a, x) * h
}

/** P(a, x), the regularized lower incomplete gamma function. */
export function gammaP(a: number, x: number): number {
  if (!(x > 0)) return 0
  if (x === Infinity) return 1
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaFraction(a, x)
}

/** Q(a, x) = 1 − P(a, x), computed directly so the upper tail keeps its digits. */
export function gammaQ(a: number, x: number): number {
  if (!(x > 0)) return 1
  if (x === Infinity) return 0
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaFraction(a, x)
}

// Modified Lentz evaluation of the continued fraction for I_x(a, b).
function betaFraction(x: number, a: number, b: number): number {
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < TINY) d = TINY
  d = 1 / d
  let h = d
  for (let m = 1; m < 100000; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const step = d * c
    h *= step
    if (Math.abs(step - 1) < EPS) break
  }
  return h
}

export const lbeta = (a: number, b: number) => lgamma(a) + lgamma(b) - lgamma(a + b)

/** I_x(a, b), the regularized incomplete beta function. */
export function betaI(x: number, a: number, b: number): number {
  if (!(x > 0)) return 0
  if (!(x < 1)) return 1
  const front = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - lbeta(a, b))
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(x, a, b)) / a : 1 - (front * betaFraction(1 - x, b, a)) / b
}

/**
 * The root of an increasing distribution function: Newton steps from a start, kept inside a
 * bracket that every evaluation narrows, bisecting whenever a step would leave it. `excess(x)` is
 * F(x) − u, computed from whichever tail keeps its digits.
 */
function invert(excess: (x: number) => number, density: (x: number) => number, start: number, lo: number, hi: number, scale: number): number {
  let x = start
  for (let i = 0; i < 300; i++) {
    const e = excess(x)
    if (e === 0 || Math.abs(e) <= 1e-14 * scale) return x
    if (e > 0) hi = x
    else lo = x
    let next = x - e / density(x)
    if (!(next > lo && next < hi)) next = hi === Infinity ? 2 * x + 1e-300 : (lo + hi) / 2
    if (Math.abs(next - x) <= 1e-15 * Math.abs(x)) return next
    x = next
  }
  return x
}

/** The u-quantile of the gamma distribution with this shape and rate 1. */
export function gammaQuantile(u: number, shape: number): number {
  const lg = lgamma(shape)
  let start: number
  if (shape >= 1) {
    // Wilson and Hilferty's cube-root normal approximation.
    const s = 1 / (9 * shape)
    start = shape * Math.max(1 - s + normalQuantile(u) * Math.sqrt(s), 0.05) ** 3
  } else {
    // Near zero P(a, x) ≈ x^a / Γ(a + 1).
    start = Math.exp((Math.log(u) + lgamma(shape + 1)) / shape)
    if (!(start > 0 && start < Infinity)) start = shape
  }
  const upper = u > 0.5
  const excess = upper ? (x: number) => 1 - u - gammaQ(shape, x) : (x: number) => gammaP(shape, x) - u
  const density = (x: number) => Math.exp((shape - 1) * Math.log(x) - x - lg)
  return invert(excess, density, start, 0, Infinity, upper ? 1 - u : u)
}

/** The u-quantile of the beta distribution. */
export function betaQuantile(u: number, a: number, b: number): number {
  // The upper half is the lower half of the mirrored distribution, where I_x keeps its digits.
  if (u > 0.5) return 1 - betaQuantile(1 - u, b, a)
  const lb = lbeta(a, b)
  // Near zero I_x(a, b) ≈ x^a / (a B(a, b)).
  let start = Math.exp((Math.log(u * a) + lb) / a)
  if (!(start > 0 && start < 1)) start = a / (a + b)
  const density = (x: number) => Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - lb)
  return invert((x) => betaI(x, a, b) - u, density, start, 0, 1, u)
}

/** ln of the mean of exp(xs), without overflow. */
export function logMeanExp(xs: ArrayLike<number>): number {
  let max = -Infinity
  for (let i = 0; i < xs.length; i++) if (xs[i] > max) max = xs[i]
  if (max === -Infinity || !Number.isFinite(max)) return max
  let sum = 0
  for (let i = 0; i < xs.length; i++) sum += Math.exp(xs[i] - max)
  return max + Math.log(sum / xs.length)
}
