// The statistics of a run, the same for every method: weighted means, spreads and quantiles, and
// the Monte Carlo standard error (MCSE) of each. A single replicate of equal-weight draws takes its
// errors from formulas; independent replicates take theirs from how far the replicates disagree,
// which holds for any method, however its draws depend on each other within a replicate.
import type { Cdf, EventSummary, Histogram, Summary } from './types.js'

export interface Column {
  values: Float64Array
  weights: Float64Array | null
}

/** Finite values in increasing order; weights (summing to 1) and their cumulative midpoints when unequal. */
interface Part {
  x: Float64Array
  w: Float64Array | null
  mid: Float64Array | null
  dropped: number
}

function weighted(x: Float64Array, w: Float64Array, dropped: number): Part {
  const index = Uint32Array.from({ length: x.length }, (_, i) => i).sort((a, b) => x[a] - x[b])
  const xs = new Float64Array(x.length)
  const ws = new Float64Array(x.length)
  let total = 0
  for (let j = 0; j < index.length; j++) { xs[j] = x[index[j]]; ws[j] = w[index[j]]; total += ws[j] }
  const mid = new Float64Array(x.length)
  let cum = 0
  for (let j = 0; j < ws.length; j++) { ws[j] /= total; mid[j] = cum + ws[j] / 2; cum += ws[j] }
  return { x: xs, w: ws, mid, dropped }
}

/** A replicate's finite values with positive weight; the rest are counted, never summarized. */
function part({ values, weights }: Column): Part {
  const n = values.length
  let kept = 0
  let dropped = 0
  for (let i = 0; i < n; i++) {
    if (weights && !(weights[i] > 0)) continue
    if (Number.isFinite(values[i])) kept++
    else dropped++
  }
  const x = new Float64Array(kept)
  const w = weights ? new Float64Array(kept) : null
  for (let i = 0, j = 0; i < n; i++) {
    if (weights && !(weights[i] > 0)) continue
    if (!Number.isFinite(values[i])) continue
    x[j] = values[i]
    if (w) w[j] = weights![i]
    j++
  }
  if (!w) return { x: x.sort(), w: null, mid: null, dropped }
  return weighted(x, w, dropped)
}

function merge(parts: Part[]): Part {
  const n = parts.reduce((s, p) => s + p.x.length, 0)
  const x = new Float64Array(n)
  const w = new Float64Array(n)
  let k = 0
  for (const p of parts) {
    for (let j = 0; j < p.x.length; j++, k++) {
      x[k] = p.x[j]
      w[k] = (p.w ? p.w[j] : 1 / p.x.length) / parts.length
    }
  }
  return weighted(x, w, parts.reduce((s, p) => s + p.dropped, 0))
}

const ess = (p: Part) => (p.w ? 1 / p.w.reduce((s, w) => s + w * w, 0) : p.x.length)

function meanOf(p: Part): number {
  let s = 0
  if (p.w) for (let j = 0; j < p.x.length; j++) s += p.w[j] * p.x[j]
  else { for (let j = 0; j < p.x.length; j++) s += p.x[j]; s /= p.x.length }
  return s
}

/** Central moments 2 and 4, with the reliability-weight correction that makes m2 unbiased. */
function moments(p: Part, mean: number): { variance: number; m4: number } {
  let m2 = 0
  let m4 = 0
  const n = p.x.length
  for (let j = 0; j < n; j++) {
    const w = p.w ? p.w[j] : 1 / n
    const d2 = (p.x[j] - mean) ** 2
    m2 += w * d2
    m4 += w * d2 * d2
  }
  const sumSq = p.w ? 1 / ess(p) : 1 / n
  return { variance: sumSq < 1 ? m2 / (1 - sumSq) : 0, m4 }
}

/** The q-quantile, interpolating between the midpoints of each value's share (Hazen's rule when the weights are equal). */
function quantileOf(p: Part, q: number): number {
  const n = p.x.length
  if (n === 1) return p.x[0]
  if (!p.mid) {
    const h = q * n - 0.5
    if (h <= 0) return p.x[0]
    if (h >= n - 1) return p.x[n - 1]
    const i = Math.floor(h)
    return p.x[i] + (h - i) * (p.x[i + 1] - p.x[i])
  }
  const mid = p.mid
  if (q <= mid[0]) return p.x[0]
  if (q >= mid[n - 1]) return p.x[n - 1]
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (mid[m] <= q) lo = m
    else hi = m
  }
  const span = mid[hi] - mid[lo]
  return span > 0 ? p.x[lo] + ((q - mid[lo]) / span) * (p.x[hi] - p.x[lo]) : p.x[hi]
}

/** A quantile's MCSE from one replicate: half the width of ±1 standard error of its rank, mapped to values. */
function quantileMcse(p: Part, q: number): number {
  const d = Math.sqrt((q * (1 - q)) / ess(p))
  return (quantileOf(p, Math.min(1, q + d)) - quantileOf(p, Math.max(0, q - d))) / 2
}

export function sampleSd(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

const QUANTILES = [['p5', 0.05], ['p50', 0.5], ['p95', 0.95]] as const

function estimates(p: Part) {
  const mean = meanOf(p)
  const { variance, m4 } = moments(p, mean)
  const sd = Math.sqrt(variance)
  return { mean, sd, m4, p5: quantileOf(p, 0.05), p50: quantileOf(p, 0.5), p95: quantileOf(p, 0.95) }
}

export interface Described {
  summary: Summary
  histogram: Histogram
  cdf: Cdf
}

const NONE: Summary = { n: 0, nonfinite: 0, mean: NaN, sd: NaN, p5: NaN, p50: NaN, p95: NaN, mcse: { mean: NaN, sd: NaN, p5: NaN, p50: NaN, p95: NaN } }

/** Summarizes one output over its replicates, with a histogram and a CDF of the pooled draws for a figure. */
export function describe(columns: Column[]): Described {
  const parts = columns.map(part)
  const nonfinite = parts.reduce((s, p) => s + p.dropped, 0)
  const live = parts.filter((p) => p.x.length > 0)
  if (!live.length) return { summary: { ...NONE, nonfinite }, histogram: { edges: [], share: [], below: 0, above: 0 }, cdf: { p: [], x: [] } }
  const pooled = live.length === 1 ? live[0] : merge(live)
  const est = estimates(pooled)
  let mcse: Summary['mcse']
  if (live.length >= 2) {
    const per = live.map(estimates)
    const root = Math.sqrt(live.length)
    mcse = { mean: sampleSd(per.map((s) => s.mean)) / root, sd: sampleSd(per.map((s) => s.sd)) / root, p5: sampleSd(per.map((s) => s.p5)) / root, p50: sampleSd(per.map((s) => s.p50)) / root, p95: sampleSd(per.map((s) => s.p95)) / root }
  } else {
    const n = ess(pooled)
    // The delta method on the sample variance: Var(s²) ≈ (m4 − s⁴) / n.
    const sdError = est.sd > 0 ? Math.sqrt(Math.max(0, est.m4 - est.sd ** 4) / n) / (2 * est.sd) : 0
    mcse = { mean: est.sd / Math.sqrt(n), sd: sdError, p5: quantileMcse(pooled, 0.05), p50: quantileMcse(pooled, 0.5), p95: quantileMcse(pooled, 0.95) }
  }
  const summary: Summary = { n: live.reduce((s, p) => s + p.x.length, 0), nonfinite, mean: est.mean, sd: est.sd, p5: est.p5, p50: est.p50, p95: est.p95, mcse }
  return { summary, histogram: histogramOf(pooled), cdf: cdfOf(pooled) }
}

/** The probability of an event (a column of 1, 0 or NaN) and its MCSE. */
export function describeEvent(columns: Column[]): EventSummary {
  const per: { p: number; n: number; ess: number }[] = []
  let hits = 0
  let n = 0
  let nonfinite = 0
  for (const { values, weights } of columns) {
    let sum = 0
    let total = 0
    let sumSq = 0
    let count = 0
    for (let i = 0; i < values.length; i++) {
      const w = weights ? weights[i] : 1
      if (!(w > 0)) continue
      const v = values[i]
      if (v !== v) { nonfinite++; continue }
      count++
      if (v !== 0) { hits++; sum += w }
      total += w
      sumSq += w * w
    }
    n += count
    if (total > 0) per.push({ p: sum / total, n: count, ess: (total * total) / sumSq })
  }
  if (!per.length) return { p: NaN, mcse: NaN, hits, n, nonfinite }
  const p = per.reduce((s, r) => s + r.p, 0) / per.length
  const mcse = per.length >= 2 ? sampleSd(per.map((r) => r.p)) / Math.sqrt(per.length) : Math.sqrt((p * (1 - p)) / per[0].ess)
  return { p, mcse, hits, n, nonfinite }
}

const BINS = 30

/** Bins over the central 99% of the weight; the tails beyond are counted apart, never folded into the edge bins. */
function histogramOf(p: Part): Histogram {
  const lo = quantileOf(p, 0.005)
  const hi = quantileOf(p, 0.995)
  if (!(hi > lo)) return { edges: [lo, hi], share: [1], below: 0, above: 0 }
  const width = (hi - lo) / BINS
  const share = new Array<number>(BINS).fill(0)
  let below = 0
  let above = 0
  const n = p.x.length
  for (let j = 0; j < n; j++) {
    const w = p.w ? p.w[j] : 1 / n
    const x = p.x[j]
    if (x < lo) below += w
    else if (x > hi) above += w
    else share[Math.min(BINS - 1, Math.floor((x - lo) / width))] += w
  }
  return { edges: Array.from({ length: BINS + 1 }, (_, i) => lo + i * width), share, below, above }
}

function cdfOf(p: Part): Cdf {
  const ps = Array.from({ length: 41 }, (_, i) => i / 40)
  return { p: ps, x: ps.map((q) => (q === 0 ? p.x[0] : q === 1 ? p.x[p.x.length - 1] : quantileOf(p, q))) }
}

/** Ranks from 1, ties sharing their average rank. */
function ranks(v: Float64Array): Float64Array {
  const index = Uint32Array.from({ length: v.length }, (_, i) => i).sort((a, b) => v[a] - v[b])
  const r = new Float64Array(v.length)
  for (let i = 0; i < index.length;) {
    let j = i
    while (j + 1 < index.length && v[index[j + 1]] === v[index[i]]) j++
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) r[index[k]] = rank
    i = j + 1
  }
  return r
}

/** Spearman's rank correlation of two equally long columns. */
export function rankCorrelation(x: Float64Array, y: Float64Array): number {
  const rx = ranks(x)
  const ry = ranks(y)
  const n = x.length
  const m = (n + 1) / 2
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const a = rx[i] - m
    const b = ry[i] - m
    sxy += a * b
    sxx += a * a
    syy += b * b
  }
  return sxy / Math.sqrt(sxx * syy)
}

/** Weighted mean and quantiles of one column, for a step of the sequential method's series. */
export function band(values: Float64Array, weights: Float64Array): { mean: number; p5: number; p50: number; p95: number } {
  const p = part({ values, weights })
  if (!p.x.length) return { mean: NaN, p5: NaN, p50: NaN, p95: NaN }
  const q = Object.fromEntries(QUANTILES.map(([k, v]) => [k, quantileOf(p, v)])) as { p5: number; p50: number; p95: number }
  return { mean: meanOf(p), ...q }
}
