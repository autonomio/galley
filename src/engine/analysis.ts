// The analysis runtime. A paper with data is held to the standard of its field:
// the author plans the analyses, a statistician from another family reviews the
// plan, and the analyses run as real code (Python with numpy, scipy, pandas and
// statsmodels) on this machine, in a sandbox with no network that can write only
// to its own folder. Every number the paper states about the data comes from
// what that code printed, with its uncertainty, its n and the checks of its
// assumptions; an analysis that did not run is never described.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The packages every analysis can import. */
export const PACKAGES = ['numpy', 'scipy', 'pandas', 'statsmodels']
const ENV = join(homedir(), '.galley', 'analysis')
const TIMEOUT_MS = 180_000

/** One named result an analysis prints: a number with what it rests on. */
export interface AnalysisResult {
  name: string
  value: number
  /** 'share' for a proportion (0 to 1), else the unit the number is in. */
  unit?: string
  /** The number of observations behind it (the denominator of a share). */
  n?: number
  /** For a share: how many met it. */
  count?: number
  ci_low?: number
  ci_high?: number
  ci_level?: number
  method: string
}

/** An assumption the analysis checked, and what the check found. */
export interface AssumptionCheck { assumption: string; method: string; statistic?: number; p?: number; holds: boolean; note: string }

export interface AnalysisRun { ok: boolean; results: AnalysisResult[]; checks: AssumptionCheck[]; error?: string; stderr?: string; ms: number }

function which(names: string[]): string | null {
  for (const name of names) {
    if (name.startsWith('/')) { if (existsSync(name)) return name; continue }
    try { return execFileSync('which', [name]).toString().trim() || null } catch { /* not on PATH */ }
  }
  return null
}

/** A command that runs without holding up the rest of the paper, however long it takes. */
const exec = (cmd: string, args: string[], timeout: number) => new Promise<string>((resolve, reject) =>
  execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)))

const importsOk = async (python: string) => {
  try { await exec(python, ['-c', `import ${PACKAGES.join(', ')}`], 120_000); return true } catch { return false }
}

/**
 * A Python that has the analysis packages: GALLEY_ANALYSIS_PYTHON, or galley's own environment in ~/.galley/analysis,
 * made on first use with uv (or venv and pip). Null when none can be had; the paper then measures with galley's
 * built-in operations.
 */
export async function ensureAnalysisEnv(log: (line: string) => void = () => {}): Promise<string | null> {
  const given = process.env.GALLEY_ANALYSIS_PYTHON
  if (given) return await importsOk(given) ? given : null
  const python = join(ENV, '.venv', 'bin', 'python')
  if (existsSync(python) && await importsOk(python)) return python
  mkdirSync(ENV, { recursive: true })
  const uv = which(['uv', join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/opt/homebrew/bin/uv'])
  try {
    log(`Making the analysis environment in ${ENV} (${PACKAGES.join(', ')}); this happens once …`)
    if (uv) {
      await exec(uv, ['venv', join(ENV, '.venv'), '--python', '3.12', '--quiet'], 600_000)
      await exec(uv, ['pip', 'install', '--python', python, '--quiet', ...PACKAGES], 900_000)
    } else {
      const system = which(['python3'])
      if (!system) return null
      await exec(system, ['-m', 'venv', join(ENV, '.venv')], 600_000)
      await exec(python, ['-m', 'pip', 'install', '--quiet', ...PACKAGES], 900_000)
    }
  } catch (error) {
    log(`The analysis environment could not be made: ${(error as Error).message.slice(0, 300)}`)
    return null
  }
  return await importsOk(python) ? python : null
}

/** The installed versions, for the reproduction package. */
export async function versions(python: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await exec(python, ['-c', `import json, platform, ${PACKAGES.join(', ')}; print(json.dumps({"python": platform.python_version(), ${PACKAGES.map((p) => `"${p}": ${p}.__version__`).join(', ')}}))`], 60_000))
  } catch { return {} }
}

/** Whether code can run sealed off: macOS's sandbox. Without it, galley runs no model-written code. */
export const canSandbox = () => process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

/**
 * The code an analysis is run inside: it loads the datasets it is given and prints what run() returns, as JSON. With a
 * shared preparation, every analysis starts from the same prepared data and the same shared methods: prepare(data) runs
 * first, and run(prepared, data) gets what it returned. For the preparation's own check, it prints prepare()'s report.
 */
export function harness(code: string, prep = '', mode: 'analysis' | 'preparation' = 'analysis'): string {
  const main = mode === 'preparation'
    ? '    prepared = prepare(data)\n    print(json.dumps(_clean(prepared.get("report", {}))))'
    : prep ? '    out = run(prepare(data), data)\n    print(json.dumps(_clean(out)))' : '    out = run(data)\n    print(json.dumps(_clean(out)))'
  return `# Written for a galley paper. Run: python analysis.py data.json
import json, math, sys
import numpy as np
import pandas as pd

def _clean(value):
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return None if math.isnan(float(value)) or math.isinf(float(value)) else float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    return value

${prep.trim() ? `# ---- the shared preparation and methods, the same for every analysis of this paper ----
${prep.trim()}
# ---- end of the shared preparation ----

` : ''}${mode === 'analysis' ? `# ---- the analysis ----
${code.trim()}
# ---- end of the analysis ----

` : ''}if __name__ == "__main__":
    paths = json.load(open(sys.argv[1]))
    data = {key: pd.read_csv(path) for key, path in paths.items()}
${main}
`
}

/** What the shared preparation reports: each step with the rows it kept, and the definitions every analysis uses. */
export interface PreparationReport { steps: { step: string; rows_before?: number; rows_after?: number; note: string }[]; definitions: string[] }

/** Run the shared preparation alone in the sandbox, to check it before any analysis builds on it. */
export function runPreparation(python: string, dir: string, prep: string, data: Record<string, string>): Promise<{ ok: boolean; report?: PreparationReport; error?: string }> {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'prepare.py'), harness('', prep, 'preparation'))
  writeFileSync(join(dir, 'data.json'), JSON.stringify(data, null, 2))
  return new Promise((resolve) => {
    execFile('/usr/bin/sandbox-exec', ['-p', sandboxProfile(dir), python, 'prepare.py', 'data.json'], { cwd: dir, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: dir, MPLCONFIGDIR: dir } }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: (stderr || error.message).split('\n').slice(-12).join('\n').slice(0, 1500) })
      try {
        const raw = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}')
        const steps = (Array.isArray(raw?.steps) ? raw.steps : []).map((s: any) => ({
          step: String(s?.step ?? ''), note: String(s?.note ?? ''),
          ...(num(s?.rows_before) !== undefined ? { rows_before: num(s.rows_before) } : {}), ...(num(s?.rows_after) !== undefined ? { rows_after: num(s.rows_after) } : {}),
        })).filter((s: { step: string }) => s.step)
        resolve({ ok: true, report: { steps, definitions: (Array.isArray(raw?.definitions) ? raw.definitions : []).map(String) } })
      } catch (e) {
        resolve({ ok: false, error: `prepare() must return a dict whose "report" holds its steps and definitions: ${(e as Error).message}` })
      }
    })
  })
}

/**
 * Analyses grouped for writing: those that refer to one another (P5 builds on P1's bounds) are written together, so
 * they use one method; the rest are packed a few to a call. A group too large for one call is split in plan order,
 * and the shared methods keep its parts consistent.
 */
export function dependencyBatches<T extends { id: string; question: string; method: string; uncertainty: string; checks: string[] }>(plan: T[], size = 3, largest = 4): T[][] {
  const ids = new Set(plan.map((p) => p.id))
  const parent = new Map(plan.map((p) => [p.id, p.id]))
  const find = (x: string): string => parent.get(x) === x ? x : find(parent.get(x)!)
  for (const p of plan) {
    const text = [p.question, p.method, p.uncertainty, ...p.checks].join(' ')
    for (const ref of text.match(/\b[AP]\d+\b/g) ?? []) if (ref !== p.id && ids.has(ref)) parent.set(find(ref), find(p.id))
  }
  const components = new Map<string, T[]>()
  for (const p of plan) components.set(find(p.id), [...(components.get(find(p.id)) ?? []), p])
  const batches: T[][] = []
  let open: T[] = []
  for (const group of components.values()) {
    if (group.length > 1) {
      for (let i = 0; i < group.length; i += largest) batches.push(group.slice(i, i + largest))
      continue
    }
    open.push(group[0])
    if (open.length === size) { batches.push(open); open = [] }
  }
  if (open.length) batches.push(open)
  return batches
}

function sandboxProfile(dir: string): string {
  return `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath "${dir}") (subpath "/private/var/folders") (subpath "/private/tmp") (literal "/dev/null"))`
}

const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : undefined

/** What an analysis printed, kept only where it is well formed: named finite numbers, and checks that say whether they hold. */
export function readRun(stdout: string): { results: AnalysisResult[]; checks: AssumptionCheck[] } {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}'
  const raw = JSON.parse(line)
  const results: AnalysisResult[] = (Array.isArray(raw?.results) ? raw.results : []).flatMap((r: any) => {
    const value = num(r?.value)
    if (value === undefined || !r?.name) return []
    return [{
      name: String(r.name), value, method: String(r.method ?? ''), ...(r.unit ? { unit: String(r.unit) } : {}),
      ...(num(r.n) !== undefined ? { n: num(r.n) } : {}), ...(num(r.count) !== undefined ? { count: num(r.count) } : {}),
      ...(num(r.ci_low) !== undefined && num(r.ci_high) !== undefined ? { ci_low: num(r.ci_low), ci_high: num(r.ci_high), ci_level: num(r.ci_level) ?? 0.95 } : {}),
    }]
  })
  const checks: AssumptionCheck[] = (Array.isArray(raw?.checks) ? raw.checks : []).flatMap((c: any) => c?.assumption ? [{
    assumption: String(c.assumption), method: String(c.method ?? ''), holds: !!c.holds, note: String(c.note ?? ''),
    ...(num(c.statistic) !== undefined ? { statistic: num(c.statistic) } : {}), ...(num(c.p) !== undefined ? { p: num(c.p) } : {}),
  }] : [])
  return { results, checks }
}

/** Run one analysis in the sandbox: its own folder, the datasets as CSV paths, no network, a time limit; with the shared preparation first, when there is one. */
export function runAnalysis(python: string, dir: string, code: string, data: Record<string, string>, prep = ''): Promise<AnalysisRun> {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'analysis.py'), harness(code, prep))
  writeFileSync(join(dir, 'data.json'), JSON.stringify(data, null, 2))
  const started = Date.now()
  return new Promise((resolve) => {
    execFile('/usr/bin/sandbox-exec', ['-p', sandboxProfile(dir), python, 'analysis.py', 'data.json'], { cwd: dir, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: dir, MPLCONFIGDIR: dir } }, (error, stdout, stderr) => {
      const ms = Date.now() - started
      if (error) return resolve({ ok: false, results: [], checks: [], error: (stderr || error.message).split('\n').slice(-12).join('\n').slice(0, 1500), stderr, ms })
      try {
        const { results, checks } = readRun(stdout)
        if (!results.length) return resolve({ ok: false, results, checks, error: 'run() returned no results with a name and a finite value', stderr, ms })
        resolve({ ok: true, results, checks, stderr, ms })
      } catch (e) {
        resolve({ ok: false, results: [], checks: [], error: `the output was not the JSON run() should return: ${(e as Error).message}`, stderr, ms })
      }
    })
  })
}

/** A number as a reader should see it: four significant figures at most, thousands separated. */
export function formatNumber(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  if (Number.isInteger(x)) return x.toLocaleString('en-US')
  const digits = Math.abs(x) >= 1000 ? 1 : Math.max(0, 3 - Math.floor(Math.log10(Math.abs(x) || 1)))
  return Number(x.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits })
}

/** A result as the paper states it: a share with its count and n, a number with its unit, each with its interval when it has one. */
export function formatResult(r: AnalysisResult): { value: string; ci: string; summary: string } {
  const share = r.unit === 'share'
  // A unit prints as a unit: a qualifier the code gave it ("ms (label)": milliseconds, as the column is labelled) goes
  // with the method, not after every number.
  const unit = r.unit && !share ? r.unit.replace(/\s*\([^)]*\)\s*$/, '').trim() : ''
  const qualified = unit && unit !== r.unit ? `; unit: ${r.unit}` : ''
  const show = (x: number) => share ? `${formatNumber(x * 100)}%` : `${formatNumber(x)}${unit ? ` ${unit}` : ''}`
  const value = share && r.count !== undefined && r.n !== undefined ? `${show(r.value)} (${formatNumber(r.count)} of ${formatNumber(r.n)})` : show(r.value)
  const ci = r.ci_low !== undefined && r.ci_high !== undefined ? `${Math.round((r.ci_level ?? 0.95) * 100)}% CI ${show(r.ci_low)} to ${show(r.ci_high)}` : ''
  const summary = `${r.name}: ${value}${ci ? ` (${ci})` : ''}${r.n !== undefined && !share ? `, n = ${formatNumber(r.n)}` : ''}; ${r.method}${qualified}`
  return { value, ci, summary }
}
