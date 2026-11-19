// Checking a rerun against what a paper cites, and the command line of a reproduction package. It
// is pure, so the published engine carries it: `node simulate.mjs --verify` and the package's page
// run this same code, bundled with the engine that produced the numbers.
import { citable, placeholders } from './cite.js'
import { ENGINE, simulate } from './core.js'
import type { SimulationResult } from './types.js'

/** What a paper cites from one simulation: every citable number as the text shows it. */
export interface Expected {
  id: string
  title: string
  engine: string
  /** The JavaScript engine the paper's run used. */
  runtime: string
  /** Of the spec the paper ran; a rerun of an edited spec has another. */
  fingerprint: string
  numbers: { key: string; value: string; step: number | null; meaning: string }[]
}

export const expectedOf = (r: SimulationResult): Expected => ({
  id: r.id,
  title: r.title,
  engine: r.provenance.engine,
  runtime: r.provenance.runtime ?? 'not recorded',
  fingerprint: r.provenance.fingerprint,
  numbers: citable(r).map(({ key, value, step, meaning }) => ({ key, value, step, meaning })),
})

export interface Difference {
  key: string
  paper: string
  rerun: string
  meaning: string
}

export interface Comparison {
  id: string
  /** Whether the rerun ran the paper's own spec. */
  same: boolean
  matched: number
  differences: Difference[]
  ok: boolean
}

const numeric = (text: string): number | null => {
  const t = text.replace(/,/g, '').replace(/%$/, '')
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null
}

// Equal text agrees. Otherwise the rerun's own number must round to the cited value at the cited
// step, so a last-digit difference between JavaScript engines never fails a check, and nothing
// coarser passes one.
function agrees(paper: Expected['numbers'][number], rerun: { value: string; number: number }): boolean {
  if (rerun.value === paper.value) return true
  const cited = numeric(paper.value)
  if (paper.step === null || cited === null || numeric(rerun.value) === null) return false
  const shown = rerun.value.endsWith('%') ? 100 * rerun.number : rerun.number
  return Math.abs(shown - cited) <= (paper.step / 2) * (1 + 1e-9) + 1e-12 * Math.abs(cited)
}

/** Compares a rerun with what the paper cites, number by number, at the cited precision. */
export function compare(expected: Expected, result: SimulationResult): Comparison {
  const rerun = new Map(citable(result).map((c) => [c.key, c]))
  const differences: Difference[] = []
  let matched = 0
  for (const paper of expected.numbers) {
    const r = rerun.get(paper.key)
    if (r && agrees(paper, r)) matched++
    else differences.push({ key: paper.key, paper: paper.value, rerun: r?.value ?? 'missing', meaning: paper.meaning })
  }
  const same = result.provenance.fingerprint === expected.fingerprint
  return { id: expected.id, same, matched, differences, ok: same && !differences.length }
}

/** What the command line reads: the spec files to run, and the expected numbers beside them. */
export interface Io {
  specs: { name: string; text: string }[]
  /** The expected numbers for a spec file (expected/<name>), or null when there are none. */
  expected(name: string): string | null
  print(line: string): void
}

export const USAGE = [
  'node simulate.mjs                  every simulation in specs/: each citable number under its placeholder key',
  'node simulate.mjs specs/S1.json    one simulation, as published or after you change it',
  'node simulate.mjs --verify         rerun every simulation and check each number against what the paper cites',
  'node simulate.mjs --json           the numbers as JSON',
].join('\n')

const pad = (rows: string[][]) => {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? []
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  '))
}

const sizeWords = (r: SimulationResult) => {
  const s = r.provenance.size
  return s.particles ? `${s.replicates} filters of ${s.particles.toLocaleString('en-US')} particles over ${s.steps} steps` : `${(s.draws ?? 0).toLocaleString('en-US')} draws`
}

function printRun(r: SimulationResult, io: Io) {
  io.print(`${r.id}  ${r.title}`)
  io.print(`    ${r.method}, ${sizeWords(r)}, seed ${r.provenance.seed} (engine ${r.provenance.engine}, ${r.provenance.runtime}, ${r.provenance.runtimeMs} ms)`)
  for (const line of pad(citable(r).map((c) => [`{{${c.key}}}`, c.value, c.meaning]))) io.print(`    ${line}`)
  const failed = r.provenance.checks.filter((c) => !c.ok)
  io.print(failed.length ? `    checks: ${failed.map((c) => `${c.name}: ${c.detail}`).join('; ')}` : '    checks: all passed')
}

/** The command line: runs the given specs, or with --verify checks them against the paper. Returns the exit code. */
export function main(flags: string[], io: Io): number {
  if (flags.includes('--help') || flags.includes('-h')) {
    io.print(USAGE)
    return 0
  }
  if (!io.specs.length) {
    io.print('No spec to run: give a spec file, or keep the specs in specs/.')
    return 1
  }
  const verify = flags.includes('--verify')
  const json = flags.includes('--json')
  let broken = 0
  let changed = 0
  let numbers = 0
  let differing = 0
  let runtime = ''
  for (const file of io.specs) {
    let spec: unknown
    try {
      spec = JSON.parse(file.text)
    } catch (error) {
      io.print(`${file.name}: not JSON (${(error as Error).message})`)
      broken++
      continue
    }
    const out = simulate(spec)
    if (!out.ok) {
      io.print(`${file.name}: the spec cannot run`)
      for (const p of out.problems) io.print(`    ${p.at || 'spec'}: ${p.message}`)
      broken++
      continue
    }
    const r = out.result
    runtime = r.provenance.runtime
    if (!verify) {
      if (json) io.print(JSON.stringify({ id: r.id, numbers: placeholders(r) }))
      else printRun(r, io)
      continue
    }
    const text = io.expected(file.name)
    if (text === null) {
      io.print(`${r.id}  no expected numbers to check against (expected/${file.name})`)
      broken++
      continue
    }
    const expected = JSON.parse(text) as Expected
    const c = compare(expected, r)
    numbers += expected.numbers.length
    differing += c.differences.length
    if (!c.same) {
      changed++
      io.print(`${r.id}  this is not the spec the paper ran (fingerprint ${r.provenance.fingerprint}, the paper's ${expected.fingerprint}), so its numbers are its own`)
    }
    if (!c.differences.length) io.print(`${r.id}  all ${c.matched} numbers match the paper`)
    else {
      io.print(`${r.id}  ${c.differences.length} of ${expected.numbers.length} numbers differ from the paper:`)
      for (const line of pad([['', 'paper', 'rerun', ''], ...c.differences.map((d) => [`{{${d.key}}}`, d.paper, d.rerun, d.meaning])])) io.print(`    ${line}`)
    }
  }
  if (!verify) return broken ? 1 : 0
  const faults = [
    differing ? `${differing} of ${numbers} numbers differ from the paper` : '',
    changed ? `${changed} spec${changed > 1 ? 's are' : ' is'} not the one the paper ran` : '',
    broken ? `${broken} spec${broken > 1 ? 's' : ''} could not be checked` : '',
  ].filter(Boolean)
  io.print(faults.length
    ? `Not verified: ${faults.join('; ')}.`
    : `Verified: all ${numbers} numbers of ${io.specs.length} simulation${io.specs.length === 1 ? '' : 's'} match the paper (engine ${ENGINE}, ${runtime}).`)
  return faults.length ? 1 : 0
}
