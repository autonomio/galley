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
  /**
   * The place the value is rounded to, in the units it is written in: 10 for 12,440, 0.1 for
   * 15.9%. Null where only the exact text agrees, as for a seed or a bound.
   */
  step: number | null
  meaning: string
}

interface Shown {
  text: string
  step: number | null
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

// A run stored as JSON comes back with null where it held NaN, which is the value it stands for.
const notFinite = (x: number | null): Shown => ({ text: x === null || x !== x ? 'not a number' : x > 0 ? 'infinite' : '−infinite', step: null })

function precise(x: number, mcse: number | null): Shown {
  if (!Number.isFinite(x)) return notFinite(x)
  const cap = Math.max(0, SIGNIFICANT - 1 - Math.floor(Math.log10(Math.abs(x) || 1)))
  if (mcse === null || !(mcse > 0) || !Number.isFinite(mcse)) return { text: written(x, cap, true), step: 10 ** -cap }
  const decimals = Math.min(cap, -Math.floor(Math.log10(mcse)))
  return { text: written(x, decimals, false), step: 10 ** -decimals }
}

/**
 * A number at the precision its Monte Carlo error supports: down to the error's leading digit, and
 * never beyond four significant digits. Without an error (a value that does not vary) it keeps four.
 */
export const atPrecision = (x: number, mcse: number | null): string => precise(x, mcse).text

/** An error itself, to two significant digits. */
function error(x: number): Shown {
  if (!Number.isFinite(x)) return notFinite(x)
  const decimals = x > 0 ? Math.max(0, 1 - Math.floor(Math.log10(x))) : 0
  return { text: written(x, decimals, false), step: 10 ** -decimals }
}

const count = (x: number): Shown => ({ text: written(Math.round(x), 0, false), step: 1 })

/** A bound one significant digit wide, rounded away from the estimate. */
function bound(x: number, up: boolean): string {
  const m = 10 ** Math.floor(Math.log10(x))
  const v = (up ? Math.ceil(x / m) : Math.floor(x / m)) * m
  return written(v, Math.max(0, -Math.floor(Math.log10(m))), true)
}

/** A probability as a percentage at its precision; one that never or always held is stated as a bound. */
function percent(p: number, mcse: number, hits: number, n: number): Shown {
  if (!(n > 0) || !Number.isFinite(p)) return { text: 'not a number', step: null }
  // Three over n is the 95% upper bound when nothing was seen in n trials.
  if (hits === 0) return { text: `< ${bound(300 / n, true)}%`, step: null }
  if (hits === n) return { text: `> ${written(100 - Number(bound(300 / n, true)), 4, true)}%`, step: null }
  const shown = precise(100 * p, 100 * mcse)
  return { text: `${shown.text}%`, step: shown.step }
}

/** Every number of a run a paper may cite, with its key, its text and what it means. */
export function citable(result: SimulationResult): Citable[] {
  const id = result.id
  const out: Citable[] = []
  const add = (key: string, number: number, shown: Shown, meaning: string) => out.push({ key: `sim.${id}.${key}`, value: shown.text, number, step: shown.step, meaning })
  const { size, seed } = result.provenance
  add('seed', seed, { text: String(seed), step: null }, 'the seed of the run')
  if (size.draws) add('draws', size.draws, count(size.draws), 'draws in the run')
  if (size.particles) add('particles', size.particles, count(size.particles), 'particles in each filter')
  if (size.particles) add('replicates', size.replicates, count(size.replicates), 'independent filters, pooled')
  if (size.steps) add('steps', size.steps, count(size.steps), 'steps simulated')
  for (const n of result.numbers) {
    add(n.key, n.value, n.count ? count(n.value) : precise(n.value, n.mcse), n.meaning)
    if (n.mcse !== null && !n.count) add(`${n.key}_mcse`, n.mcse, error(n.mcse), `Monte Carlo standard error of the ${n.meaning}`)
  }
  const at = result.series.steps ? ` at the last step (t = ${size.steps})` : ''
  for (const [name, s] of Object.entries(result.outputs)) {
    add(`${name}.mean`, s.mean, precise(s.mean, s.mcse.mean), `mean of ${name}${at}`)
    add(`${name}.sd`, s.sd, precise(s.sd, s.mcse.sd), `standard deviation of ${name}${at}`)
    add(`${name}.p5`, s.p5, precise(s.p5, s.mcse.p5), `5th percentile of ${name}${at}`)
    add(`${name}.p50`, s.p50, precise(s.p50, s.mcse.p50), `median of ${name}${at}`)
    add(`${name}.p95`, s.p95, precise(s.p95, s.mcse.p95), `95th percentile of ${name}${at}`)
    add(`${name}.mcse`, s.mcse.mean, error(s.mcse.mean), `Monte Carlo standard error of the mean of ${name}`)
  }
  // The shares of one run read at one precision: those between 1% and 99% are all written to the coarsest step any of
  // them needs, so a breakdown never sets 7.3% beside 3.64%. Coarser than a number's own error is never wrong; finer is.
  const events = Object.entries(result.events).map(([name, e]) => ({ name, e, shown: percent(e.p, e.mcse, e.hits, e.n) }))
  const middle = (e: { p: number }, shown: Shown) => shown.step !== null && e.p >= 0.01 && e.p <= 0.99
  const common = Math.max(0, ...events.filter(({ e, shown }) => middle(e, shown)).map(({ shown }) => shown.step!))
  for (const { name, e, shown } of events) {
    const when = result.spec.events.find((x) => x.name === name)?.when ?? name
    const even = common && middle(e, shown) && shown.step! < common ? { text: `${written(100 * e.p, Math.max(0, Math.round(-Math.log10(common))), false)}%`, step: common } : shown
    add(`${name}.p`, e.p, even, `probability of ${name} (${when})${at}`)
    add(`${name}.mcse`, 100 * e.mcse, error(100 * e.mcse), `Monte Carlo standard error of the probability of ${name}, in percentage points`)
  }
  return out
}

/** The citable numbers as placeholder values: spread them into the paper's record. */
export const placeholders = (result: SimulationResult): Record<string, string> => Object.fromEntries(citable(result).map((c) => [c.key, c.value]))
