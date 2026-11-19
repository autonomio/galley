// The production record, read from the journal: what ran, who answered, what
// it cost. Manuscripts state these numbers as placeholders, filled in wherever
// the text is shown (to referees, to the author, in the typeset paper), so
// they are always the run's own.
import { existsSync, readFileSync } from 'node:fs'
import type { Paper } from './paper.js'
import { simulationPlaceholders } from './simulations.js'
import type { Family } from './types.js'

export interface Record_ {
  [key: string]: string | number
}

/** The production record, from the journal: what ran, who answered, what it cost. */
export function productionRecord(paper: Paper): Record_ {
  const lines = existsSync(paper.path('journal.jsonl')) ? readFileSync(paper.path('journal.jsonl'), 'utf8').split('\n').filter(Boolean) : []
  const events = lines.map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) as any[]
  const calls = events.filter((e) => e.event === 'call' && !e.cached)
  const byFamily = (f: Family) => calls.filter((e) => e.family === f).length
  const sum = (field: 'input' | 'output') => calls.reduce((n, e) => n + (e.usage?.[field] || 0), 0)
  const first = Date.parse(paper.state.createdAt)
  const last = events.length ? Date.parse(events[events.length - 1].at) : Date.now()
  const s = paper.state
  const active = s.claims.filter((c) => c.status !== 'dropped')
  const material = s.findings.filter((f) => f.severity !== 'minor')
  const resolvedMaterial = material.filter((f) => f.status === 'adjudicated' || (['fixed', 'rebutted', 'limitation'].includes(f.status) && f.dispositions.at(-1)?.verification?.outcome !== 'disagrees'))
  return {
    'run.hours': ((last - first) / 3_600_000).toFixed(1),
    'run.calls': calls.length,
    'run.calls_claude': byFamily('claude'),
    'run.calls_gpt': byFamily('gpt'),
    'run.calls_gemini': byFamily('gemini'),
    'run.tokens_in_m': (sum('input') / 1e6).toFixed(1),
    'run.tokens_out_k': Math.round(sum('output') / 1e3),
    'run.behaviors': new Set(events.filter((e) => e.event === 'settled').map((e) => e.behavior)).size,
    'run.claims': active.length,
    'run.claims_seed': active.filter((c) => c.origin === 'seed').length,
    'run.claims_added': active.filter((c) => c.origin === 'system').length,
    'run.claims_narrowed': active.filter((c) => c.status === 'narrowed').length,
    'run.claims_unsupported': active.filter((c) => c.status === 'unsupported').length,
    'run.works_screened': Object.keys(s.works).length,
    'run.citations_verified': s.citations.filter((c) => c.status === 'verified').length,
    'run.citations_rejected': s.citations.filter((c) => c.status === 'rejected').length,
    'run.findings': s.findings.length,
    'run.findings_material': material.length,
    'run.findings_resolved': resolvedMaterial.length,
    'run.findings_adjudicated': s.findings.filter((f) => f.status === 'adjudicated').length,
    'run.rounds': s.round,
    'run.calibration': s.calibration ? `${s.calibration.caught} of ${s.calibration.planted}` : 'none to check',
    'run.calibration_controls': s.calibration ? `${s.calibration.details.filter((d) => d.kind === 'control' && d.caught).length} of ${s.calibration.details.filter((d) => d.kind === 'control').length}` : 'none to check',
    'run.claims_review': active.filter((c) => c.origin === 'review').length,
    // The systematic review's own numbers, as Canary reported them.
    ...Object.fromEntries(Object.entries(s.literature?.counts ?? {}).map(([key, value]) => [`lit.${key}`, value])),
    // Every simulated number, at the precision its Monte Carlo error supports.
    ...simulationPlaceholders(paper),
    // Numbers from the authors' data, as galley computed them.
    ...Object.fromEntries(Object.values(s.measurements ?? {}).map((m) => [`data.${m.id}`, m.value])),
  }
}

export function fillPlaceholders(text: string, record: Record_): { text: string; unknown: string[] } {
  const unknown: string[] = []
  const filled = text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (whole, key: string) => {
    if (key in record) return String(record[key])
    unknown.push(key)
    return '[not recorded]'
  })
  return { text: filled, unknown }
}
