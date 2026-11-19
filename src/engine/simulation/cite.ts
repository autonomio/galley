// The numbers a paper may cite from a run, each under a placeholder key such as
// {{sim.S1.profit.p95}}. A value is written only to the precision its Monte Carlo error supports,
// so a sentence never claims digits the simulation does not have. The paper engine fills the
// placeholders from here; a model never types a simulated figure.
import type { SimulationResult } from './types.js'

export interface Citable {
  /** The placeholder's key: {{<key>}}. */
  key: string
  /** The number as the text shows it. */
  value: string
  number: number
  meaning: string
}

const SIGNIFICANT = 4

// Separators from 10,000 on, so a year reads as 2015, not 2,015.
function written(x: number, decimals: number, trim: boolean): string {
  let d = decimals
  let v = x
  if (d < 0) {
    const step = 10 ** -d
    v = Math.round(x / step) * step
    d = 0
  }
  let s = Math.abs(v) >= 10000 ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : v.toFixed(d)
  if (trim && s.includes('.')) s = s.replace(/\.?0+$/, '')
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s
}

/**
 * A number at the precision its Monte Carlo error supports: down to the error's leading digit, and
 * never beyond four significant digits. Without an error (a value that does not vary) it keeps four.
 */
export function atPrecision(x: number, mcse: number | null): string {
  if (!Number.isFinite(x)) return x !== x ? 'not a number' : x > 0 ? 'infinite' : '−infinite'
  const cap = Math.max(0, SIGNIFICANT - 1 - Math.floor(Math.log10(Math.abs(x) || 1)))
  if (mcse === null || !(mcse > 0) || !Number.isFinite(mcse)) return written(x, cap, true)
  return written(x, Math.min(cap, -Math.floor(Math.log10(mcse))), false)
}

/** An error itself, to two significant digits. */
const errorText = (x: number) => (Number.isFinite(x) ? written(x, x > 0 ? Math.max(0, 1 - Math.floor(Math.log10(x))) : 0, false) : 'not a number')

const count = (x: number) => written(Math.round(x), 0, false)

/** A bound one significant digit wide, rounded away from the estimate. */
function bound(x: number, up: boolean): string {
  const m = 10 ** Math.floor(Math.log10(x))
  const v = (up ? Math.ceil(x / m) : Math.floor(x / m)) * m
  return written(v, Math.max(0, -Math.floor(Math.log10(m))), true)
}

/** A probability as a percentage at its precision; one that never or always held is stated as a bound. */
function percent(p: number, mcse: number, hits: number, n: number): string {
  if (!(n > 0) || !Number.isFinite(p)) return 'not a number'
  // Three over n is the 95% upper bound when nothing was seen in n trials.
  if (hits === 0) return `< ${bound((300 / n), true)}%`
  if (hits === n) return `> ${written(100 - Number(bound(300 / n, true)), 4, true)}%`
  return `${atPrecision(100 * p, 100 * mcse)}%`
}

/** Every number of a run a paper may cite, with its key, its text and what it means. */
export function citable(result: SimulationResult): Citable[] {
  const id = result.id
  const out: Citable[] = []
  const add = (key: string, number: number, value: string, meaning: string) => out.push({ key: `sim.${id}.${key}`, value, number, meaning })
  const { size, seed } = result.provenance
  add('seed', seed, String(seed), 'the seed of the run')
  if (size.draws) add('draws', size.draws, count(size.draws), 'draws in the run')
  if (size.particles) add('particles', size.particles, count(size.particles), 'particles in each filter')
  if (size.particles) add('replicates', size.replicates, count(size.replicates), 'independent filters, pooled')
  if (size.steps) add('steps', size.steps, count(size.steps), 'steps simulated')
  for (const n of result.numbers) {
    add(n.key, n.value, n.count ? count(n.value) : atPrecision(n.value, n.mcse), n.meaning)
    if (n.mcse !== null && !n.count) add(`${n.key}_mcse`, n.mcse, errorText(n.mcse), `Monte Carlo standard error of the ${n.meaning}`)
  }
  const at = result.series.steps ? ` at the last step (t = ${size.steps})` : ''
  for (const [name, s] of Object.entries(result.outputs)) {
    add(`${name}.mean`, s.mean, atPrecision(s.mean, s.mcse.mean), `mean of ${name}${at}`)
    add(`${name}.sd`, s.sd, atPrecision(s.sd, s.mcse.sd), `standard deviation of ${name}${at}`)
    add(`${name}.p5`, s.p5, atPrecision(s.p5, s.mcse.p5), `5th percentile of ${name}${at}`)
    add(`${name}.p50`, s.p50, atPrecision(s.p50, s.mcse.p50), `median of ${name}${at}`)
    add(`${name}.p95`, s.p95, atPrecision(s.p95, s.mcse.p95), `95th percentile of ${name}${at}`)
    add(`${name}.mcse`, s.mcse.mean, errorText(s.mcse.mean), `Monte Carlo standard error of the mean of ${name}`)
  }
  for (const [name, e] of Object.entries(result.events)) {
    const when = result.spec.events.find((x) => x.name === name)?.when ?? name
    add(`${name}.p`, e.p, percent(e.p, e.mcse, e.hits, e.n), `probability of ${name} (${when})${at}`)
    add(`${name}.mcse`, 100 * e.mcse, errorText(100 * e.mcse), `Monte Carlo standard error of the probability of ${name}, in percentage points`)
  }
  return out
}

/** The citable numbers as placeholder values: spread them into the paper's record. */
export const placeholders = (result: SimulationResult): Record<string, string> => Object.fromEntries(citable(result).map((c) => [c.key, c.value]))
