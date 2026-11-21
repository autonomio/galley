// Charts through Astetik. A chart shows the paper's own records and nothing else: the storyteller names the data by
// reference, galley writes it to a file from the records, and Astetik draws exactly those values from a declared
// specification and the paper's design, returning a verified evidence bundle. No model types a number into a chart,
// so a chart and the text it supports come from one source. See docs/ASTETIK.md.
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Paper } from './paper.js'
import { drawsOf } from './simulation/index.js'
import { runsOf } from './simulations.js'
import type { ChartPanel, Figure } from './types.js'

/** The kinds galley draws, pinned: the distribution of one quantity, a course with its band, estimates with their intervals. */
export const CHART_KINDS: ChartPanel['kind'][] = ['hist', 'line', 'interval']

/** One piece of data a chart may draw, as the storyteller is shown it. */
export interface ChartData { ref: string; kinds: ChartPanel['kind'][]; about: string }

type Row = Record<string, string | number>

const round = (x: number) => Number(x.toPrecision(4))

/** Every piece of data a chart of this paper may draw, by reference. */
export function chartCatalog(paper: Paper): ChartData[] {
  const out: ChartData[] = []
  for (const run of runsOf(paper)) {
    const r = run.result
    const steps = r.series.steps
    for (const [name, sum] of Object.entries(r.outputs)) {
      // A sequential run's samples are weighted: its outputs chart as estimates, not as draws to count.
      out.push({ ref: `sim:${run.id}:${name}`, kinds: steps ? ['interval'] : ['hist', 'interval'], about: `${run.id} (${run.title.replace(/[.\s]+$/, '')}), ${name}: ${sum.n.toLocaleString('en-US')} draws, median ${round(sum.p50)}, 5th to 95th percentile ${round(sum.p5)} to ${round(sum.p95)}` })
    }
    for (const name of Object.keys(steps?.bands ?? {})) {
      out.push({ ref: `steps:${run.id}:${name}`, kinds: ['line'], about: `${run.id}, ${name} over t = ${round(steps!.t[0])} to ${round(steps!.t.at(-1)!)} (${steps!.t.length} steps): its mean with the 5th to 95th percentile band` })
    }
  }
  for (const m of Object.values(paper.state.measurements ?? {})) {
    const result = measured(paper, m.id)
    if (!result) continue
    out.push({ ref: `data:${m.id}`, kinds: ['interval'], about: `${m.id} (${m.name ?? m.summary.slice(0, 60)}): ${m.value}${m.ci ? `, ${m.ci}` : ''}, n = ${m.n.toLocaleString('en-US')}` })
  }
  return out
}

/** A measurement of the authors' data with its interval, as the analysis code printed it. */
function measured(paper: Paper, id: string): { value: number; low: number; high: number; level?: number; method: string } | null {
  const m = paper.state.measurements?.[id]
  const result = m?.analysis ? paper.state.analysis?.runs?.[m.analysis]?.results.find((x) => x.name === m.name) : undefined
  if (!result || result.ci_low === undefined || result.ci_high === undefined) return null
  return { value: result.value, low: result.ci_low, high: result.ci_high, level: result.ci_level, method: result.method }
}

/** The rows a panel draws, and what each column holds, or why it cannot be drawn. */
export function panelRows(paper: Paper, panel: ChartPanel): { rows: Row[]; describe: Record<string, string> } | { problem: string } {
  const runs = new Map(runsOf(paper).map((run) => [run.id, run]))
  const label = (i: number) => panel.labels[i] || panel.data[i]
  const rows: Row[] = []
  if (panel.kind === 'hist') {
    if (!panel.data.length || panel.data.length > 3) return { problem: 'a histogram draws one to three quantities' }
    for (const [i, ref] of panel.data.entries()) {
      const [kind, id, name] = ref.split(':')
      const run = runs.get(id)
      if (kind !== 'sim' || !run || !run.result.outputs[name]) return { problem: `${ref} is not a simulated quantity of this paper` }
      const draws = drawsOf(run.result.spec, [name])?.[name]
      if (!draws) return { problem: `${ref}'s draws cannot be made again from its run` }
      const finite = draws.filter(Number.isFinite)
      // The same spec and seed give the run's own draws; a different count would mean they are not the run reported.
      if (finite.length !== run.result.outputs[name].n) return { problem: `${ref}'s draws do not reproduce the run` }
      for (const value of finite) rows.push({ row: rows.length + 1, series: label(i), value })
    }
    return { rows, describe: { value: `each of the ${(rows.length / panel.data.length).toLocaleString('en-US')} Monte Carlo draws of the run`, series: 'the run the draws come from' } }
  }
  if (panel.kind === 'line') {
    if (!panel.data.length || panel.data.length > 3) return { problem: 'a line chart draws one to three courses' }
    for (const [i, ref] of panel.data.entries()) {
      const [kind, id, name] = ref.split(':')
      const steps = runs.get(id)?.result.series.steps
      const band = steps?.bands[name]
      if (kind !== 'steps' || !steps || !band) return { problem: `${ref} is not a simulated course of this paper` }
      steps.t.forEach((t, j) => rows.push({ row: rows.length + 1, series: label(i), x: t, y: band.mean[j], lower: band.p5[j], upper: band.p95[j] }))
    }
    return { rows, describe: { y: 'the mean over the run\'s weighted samples', lower: 'the 5th percentile over the samples', upper: 'the 95th percentile over the samples', series: 'the run' } }
  }
  if (panel.data.length < 2 || panel.data.length > 12) return { problem: 'an interval chart draws two to twelve estimates' }
  const methods = new Set<string>()
  for (const [i, ref] of panel.data.entries()) {
    const [kind, id, name] = ref.split(':')
    if (kind === 'sim') {
      const sum = runs.get(id)?.result.outputs[name]
      if (!sum) return { problem: `${ref} is not a simulated quantity of this paper` }
      rows.push({ label: label(i), estimate: sum.p50, lower: sum.p5, upper: sum.p95 })
      methods.add(`the median of the run's ${sum.n.toLocaleString('en-US')} draws, with their 5th and 95th percentiles`)
    } else if (kind === 'data') {
      const m = measured(paper, id)
      if (!m) return { problem: `${ref} is not a measurement of this paper with an interval` }
      rows.push({ label: label(i), estimate: m.value, lower: m.low, upper: m.high })
      methods.add(`${m.method}, with its ${m.level ? `${Math.round(m.level * (m.level <= 1 ? 100 : 1))}% ` : ''}confidence interval`)
    } else return { problem: `${ref} is not data this paper holds` }
  }
  return { rows, describe: { estimate: [...methods].join('; '), lower: 'the lower end of the interval', upper: 'the upper end of the interval', label: 'what is estimated' } }
}

/** Rows as CSV: a header, then one line per row, text quoted where it must be. */
export function toCsv(rows: Row[]): string {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const cell = (v: string | number | undefined) => v === undefined ? '' : typeof v === 'number' ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  return `${columns.join(',')}\n${rows.map((r) => columns.map((c) => cell(r[c])).join(',')).join('\n')}\n`
}

/** What the installed Astetik draws: its kinds and the options each accepts. */
export interface AstetikCatalog { kinds: Map<string, Set<string>>; panels: boolean }

/** The Astetik command galley runs, or null when none is installed. */
export function astetikCommand(): string | null {
  const given = process.env.GALLEY_ASTETIK
  if (given) return existsSync(given) ? given : null
  const local = join(homedir(), '.galley', 'analysis', '.venv', 'bin', 'astetik')
  if (existsSync(local)) return local
  try { return execFileSync('which', ['astetik']).toString().trim() || null } catch { return null }
}

const run = (cmd: string, args: string[], env: Record<string, string>, timeout = 180_000) => new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) =>
  execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr || error?.message || '') })))

export async function astetikCatalog(cmd: string): Promise<AstetikCatalog | null> {
  const out = await run(cmd, ['catalog'], {}, 60_000)
  if (!out.ok) return null
  try {
    const catalog = JSON.parse(out.stdout)
    const kinds = new Map<string, Set<string>>(Object.entries(catalog.plots ?? {}).map(([kind, def]: [string, any]) => [kind, new Set<string>(def.options ?? [])]))
    return { kinds, panels: Array.isArray(catalog.spec_fields) ? catalog.spec_fields.includes('panels') : Boolean(catalog.spec_fields?.panels) }
  } catch { return null }
}

/** The pinned kinds this Astetik draws. */
export const drawable = (catalog: AstetikCatalog) => CHART_KINDS.filter((k) => catalog.kinds.has(k))

/** One panel's Astetik specification, with the options the installed Astetik accepts. */
export function panelSpec(panel: ChartPanel, describe: Record<string, string>, options: Set<string>): Record<string, unknown> {
  const several = panel.data.length > 1
  const opts: Record<string, unknown> = {}
  if (panel.marks.length && options.has('marks')) opts.marks = panel.marks.slice(0, 2)
  const base = { schema_version: '1.0', kind: panel.kind, legend: several, labels: { x: panel.x, y: panel.y }, missing: 'error', descriptions: describe }
  if (panel.kind === 'hist') return { ...base, x: 'value', ...(several ? { hue: 'series' } : {}), key: ['row'], units: { value: panel.unit || '1' }, options: opts }
  if (panel.kind === 'line') {
    if (options.has('band')) opts.band = { lower: 'lower', upper: 'upper' }
    return { ...base, x: 'x', y: 'y', ...(several ? { hue: 'series' } : {}), key: ['row'], units: { x: panel.xUnit || '1', y: panel.unit || '1', lower: panel.unit || '1', upper: panel.unit || '1' }, options: opts }
  }
  if (options.has('lower')) Object.assign(opts, { lower: 'lower', upper: 'upper' })
  return { ...base, x: 'estimate', y: 'label', key: ['label'], legend: false, units: { estimate: panel.unit || '1', lower: panel.unit || '1', upper: panel.unit || '1' }, options: opts }
}

/** The paper's design: its typeface where galley has the font file, and its text width. */
export function chartManifest(): Record<string, unknown> {
  const font = process.env.GALLEY_CHART_FONT
  return {
    schema_version: '1.0',
    ...(font && existsSync(font) ? { typography: { font: 'New Computer Modern', font_path: font, fontsize: 8, labelsize: 8, ticksize: 7, legendsize: 7 } } : { typography: { fontsize: 8, labelsize: 8, ticksize: 7, legendsize: 7 } }),
    paper: { preset: 'single', width_mm: 140, aspect: 1.6, dpi: 600, min_fontsize: 7 },
  }
}

/** The figure file of a bundle: the PNG galley typesets, or the vector drawing when there is no PNG. */
function figureFile(dir: string): string | null {
  const files = existsSync(dir) ? readdirSync(dir) : []
  for (const want of ['figure.png', 'figure.svg']) if (files.includes(want)) return join(dir, want)
  const any = files.find((f) => f.endsWith('.png')) ?? files.find((f) => f.endsWith('.svg'))
  return any ? join(dir, any) : null
}

/**
 * Draws a chart figure through Astetik into the paper's build: its data from the records, its specification, its
 * design, then the verified bundle's drawing copied in as the figure's file. Nothing is changed on failure.
 */
export async function drawChart(paper: Paper, fig: Figure, attempt: string): Promise<{ ok: true; file: string; bundle: string; source: string } | { ok: false; problem: string }> {
  const plan = fig.chart
  if (!plan?.panels.length) return { ok: false, problem: 'the chart has no panels' }
  const cmd = astetikCommand()
  if (!cmd) return { ok: false, problem: 'Astetik is not installed (set GALLEY_ASTETIK, or install it in the analysis environment)' }
  const catalog = await astetikCatalog(cmd)
  if (!catalog) return { ok: false, problem: 'Astetik did not report its catalogue' }
  const missing = plan.panels.map((p) => p.kind).filter((k) => !catalog.kinds.has(k))
  if (missing.length) return { ok: false, problem: `the installed Astetik does not draw ${[...new Set(missing)].join(', ')}` }
  if (plan.panels.length > 1 && !catalog.panels) return { ok: false, problem: 'the installed Astetik does not compose panels' }
  // Astetik refuses a destination that exists: an attempt that ran before starts again from nothing.
  const dir = paper.path('build', 'charts', fig.id, attempt)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const specs: Record<string, unknown>[] = []
  for (const [i, panel] of plan.panels.entries()) {
    const data = panelRows(paper, panel)
    if ('problem' in data) return { ok: false, problem: data.problem }
    writeFileSync(join(dir, `panel-${i + 1}.csv`), toCsv(data.rows))
    specs.push({ ...panelSpec(panel, data.describe, catalog.kinds.get(panel.kind)!), data: `panel-${i + 1}.csv` })
  }
  const single = specs.length === 1
  const spec = single ? { ...specs[0], paper: true } : { schema_version: '1.0', paper: true, layout: { rows: specs.length > 2 ? 2 : 1, cols: specs.length > 1 ? 2 : 1 }, panel_labels: true, panels: specs }
  if (single) delete (spec as Record<string, unknown>).data
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 1))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(chartManifest(), null, 1))
  const out = join(dir, 'bundle')
  const args = ['render', ...(single ? ['--data', join(dir, 'panel-1.csv')] : []), '--spec', join(dir, 'spec.json'), '--manifest', join(dir, 'manifest.json'), '--output', out]
  // Matplotlib keeps its cache beside the chart, so a render writes nowhere else.
  const done = await run(cmd, args, { MPLCONFIGDIR: join(dir, '.mpl') })
  if (!done.ok) {
    let problem = done.stderr.trim()
    try { const e = JSON.parse(problem); problem = `${e.code}: ${e.message}${e.details ? ` (${JSON.stringify(e.details).slice(0, 300)})` : ''}` } catch { /* not a declared failure */ }
    return { ok: false, problem: problem.slice(0, 600) || 'Astetik could not draw it' }
  }
  let result: any = {}
  try { result = JSON.parse(done.stdout) } catch { return { ok: false, problem: 'Astetik did not report its result' } }
  if (result.verification?.passed !== true) return { ok: false, problem: `the drawing did not pass Astetik's checks: ${JSON.stringify(result.verification ?? {}).slice(0, 400)}` }
  const drawn = figureFile(out)
  if (!drawn) return { ok: false, problem: 'the bundle holds no figure file' }
  const figures = paper.path('build', 'figures')
  mkdirSync(figures, { recursive: true })
  const file = `figures/${fig.id}${drawn.endsWith('.svg') ? '.svg' : '.png'}`
  copyFileSync(drawn, paper.path('build', file))
  return { ok: true, file, bundle: out, source: JSON.stringify({ spec, result: result.result_id ?? null }) }
}
