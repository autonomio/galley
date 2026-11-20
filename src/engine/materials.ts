// The authors' own materials: datasets, documents and links that a paper draws
// on besides the literature. A private dataset never leaves this machine: the
// models see only its profile and the results galley computes here, and every
// number the paper states about the data comes from those results.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Paper } from './paper.js'
import { query, resolveConnection, schema, type DatabaseSpec } from './databases.js'
import { citationKey } from './text.js'
import type { Work } from './types.js'
import { readWorkbook, sheetTable, toCsv } from './workbook.js'

export type MaterialKind = 'dataset' | 'document' | 'link'

export interface Material {
  id: string
  kind: MaterialKind
  name: string
  /** The file as given, inside the paper folder. */
  file?: string
  /** Its readable text, made once when the paper starts (documents and links). */
  text?: string
  url?: string
  /** For a dataset: only its profile and computed results reach a model. */
  private: boolean
  /** The dataset unit this file belongs to, when it came as part of one. */
  dataset?: string
}

/**
 * A dataset as its producers know it: one or more files (tables, sheets, its
 * README) under one name, with where it comes from. Its provenance decides how
 * the paper may describe it: data the authors produced is their own work; data
 * others produced, or that was published before, is cited as its source says.
 */
export interface DatasetUnit {
  id: string
  name: string
  /** Its files, as materials (a workbook gives one per data sheet). */
  materials: string[]
  producedBy: 'authors' | 'others'
  version?: string
  /** Where it is published: a DOI or a link. */
  doi?: string
  url?: string
  /** The publication that first reported it: a DOI or a link. */
  describedIn?: string
  licence?: string
  /** How its producers ask for it to be cited, as they wrote it. */
  citation?: string
  private: boolean
  /**
   * A database rather than files: the connection's name in the connections file (never its password), the database,
   * and the snapshot of its schema the models plan from. Its materials are the extracts the analyses take from it.
   */
  connection?: string
  database?: string
  schemaFile?: string
}

/** A dataset as the start dialog or a manifest file gives it. */
export interface DatasetManifest {
  name: string
  files: string[]
  producedBy?: 'authors' | 'others'
  version?: string
  doi?: string
  url?: string
  describedIn?: string
  licence?: string
  citation?: string
  private?: boolean
}

const doiIn = (text = '') => text.match(/10\.\d{4,9}\/[^\s"<>]+/)?.[0].replace(/[.,;)]+$/, '').toLowerCase()

/** Datasets as units: each one's files are added as materials, and the unit keeps its provenance. */
export async function addDatasets(dir: string, manifests: DatasetManifest[], offset = 0): Promise<{ materials: Material[]; datasets: DatasetUnit[] }> {
  const materials: Material[] = []
  const datasets: DatasetUnit[] = []
  for (const [i, m] of manifests.entries()) {
    const id = `D${i + 1}`
    const added = await addMaterials(dir, m.files.map((source) => ({ source, shared: m.private === false })), offset + materials.length)
    for (const item of added) item.dataset = id
    materials.push(...added)
    const doi = doiIn(m.doi) ?? undefined
    datasets.push({
      id, name: m.name.trim() || id, materials: added.map((a) => a.id), producedBy: m.producedBy === 'others' ? 'others' : 'authors',
      ...(m.version?.trim() ? { version: m.version.trim() } : {}), ...(doi ? { doi } : {}),
      ...(!doi && /^https?:\/\//i.test(m.doi ?? '') ? { url: m.doi!.trim() } : m.url?.trim() ? { url: m.url.trim() } : {}),
      ...(m.describedIn?.trim() ? { describedIn: m.describedIn.trim() } : {}), ...(m.licence?.trim() ? { licence: m.licence.trim() } : {}),
      ...(m.citation?.trim() ? { citation: m.citation.trim() } : {}), private: m.private !== false,
    })
  }
  return { materials, datasets }
}

/** A database added to a paper: its connection saved by name, its schema kept as a snapshot for the models to plan from. */
export async function addDatabase(dir: string, spec: DatabaseSpec, id: string): Promise<DatasetUnit> {
  const connection = await resolveConnection(spec)
  const tables = await schema(connection)
  const version = (await query(connection, connection.database, 'SELECT version()', 'TSV')).trim()
  mkdirSync(join(dir, 'materials'), { recursive: true })
  const schemaFile = join('materials', `${id}-schema.json`)
  writeFileSync(join(dir, schemaFile), JSON.stringify({ version, database: connection.database, tables }, null, 2))
  return {
    id, name: spec.name?.trim() || connection.database, materials: [], producedBy: spec.producedBy === 'authors' ? 'authors' : 'others',
    private: spec.private !== false, connection: connection.name, database: connection.database, schemaFile,
  }
}

/** Write the paper's materials and datasets back to its paper.json, as they grow (a database's extracts). */
export function saveMaterials(paper: Paper): void {
  const path = paper.path('paper.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.materials = paper.config.materials
  config.datasets = paper.config.datasets
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
}

/**
 * The sources a dataset is cited by: the dataset itself when it is published, and
 * the publication that first reported it. Kept as works, so the paper cites them
 * like any other source and they appear in the references.
 */
export function datasetSources(paper: Paper, unit: DatasetUnit): { data?: string; article?: string } {
  const works = paper.state.works
  const out: { data?: string; article?: string } = {}
  if (unit.doi || unit.url) {
    const id = `dataset:${unit.id}`
    works[id] ??= {
      id, doi: unit.doi ?? null, title: unit.name, authors: [], year: null, venue: null, abstract: '', citedBy: null, url: unit.url ?? (unit.doi ? `https://doi.org/${unit.doi}` : null),
      // A dataset with no record behind its DOI is still listed as the dataset it is.
      csl: unit.doi ? undefined : { type: 'dataset', title: unit.name, ...(unit.version ? { version: unit.version } : {}), URL: unit.url },
    } as Work
    out.data = id
  }
  if (unit.describedIn) {
    const id = `dataset:${unit.id}:article`
    const doi = doiIn(unit.describedIn)
    works[id] ??= { id, doi: doi ?? null, title: doi ? '' : unit.describedIn, authors: [], year: null, venue: null, abstract: '', citedBy: null, url: doi ? `https://doi.org/${doi}` : unit.describedIn } as Work
    out.article = id
  }
  return out
}

const UA = process.env.GALLEY_USER_AGENT || 'scholarly-client/0.1'
const PLAIN = new Set(['.md', '.markdown', '.txt', '.tex', '.rst', '.org', '.bib'])

/** A document as text: plain formats as they are, others through pandoc, PDF through pdftotext. Null when it cannot be read. */
function documentText(path: string): string | null {
  const ext = extname(path).toLowerCase()
  try {
    if (PLAIN.has(ext)) return readFileSync(path, 'utf8')
    if (ext === '.pdf') return execFileSync('pdftotext', ['-layout', path, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString()
    return execFileSync('pandoc', [path, '-t', 'plain', '--wrap=none'], { maxBuffer: 64 * 1024 * 1024 }).toString()
  } catch {
    return null
  }
}

export function htmlText(html: string): string {
  return html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}

/** A link's readable text, fetched once when the paper starts so every step reads the same page. */
async function linkText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return null
    const body = await response.text()
    return /html/i.test(response.headers.get('content-type') ?? '') ? htmlText(body) : body.slice(0, 400_000)
  } catch {
    return null
  }
}

/** Copy files into the paper's materials folder and read links; a dataset stays private unless it is named shared. */
export async function addMaterials(dir: string, sources: { source: string; shared?: boolean; name?: string }[], offset = 0): Promise<Material[]> {
  mkdirSync(join(dir, 'materials'), { recursive: true })
  const out: Material[] = []
  let count = offset
  for (const { source, shared, name } of sources) {
    const id = `M${++count}`
    const kind = kindOf(source)
    if (kind === 'link') {
      const text = await linkText(source)
      if (text) writeFileSync(join(dir, 'materials', `${id}.txt`), text)
      out.push({ id, kind, name: source, url: source, ...(text ? { text: join('materials', `${id}.txt`) } : {}), private: false })
      continue
    }
    const shown = name || basename(source)
    const file = join('materials', `${id}-${shown.replace(/[^\w.-]+/g, '_')}`)
    copyFileSync(source, join(dir, file))
    // A workbook becomes one dataset per sheet that holds data columns; the workbook itself stays in materials/.
    if (extname(source).toLowerCase() === '.xlsx') {
      let first = true
      for (const sheet of readWorkbook(source)) {
        const table = sheetTable(sheet)
        if (!table) continue
        const sheetId = first ? id : `M${++count}`
        first = false
        const csv = join('materials', `${sheetId}-${shown.replace(/\.xlsx$/i, '').replace(/[^\w.-]+/g, '_')}-${sheet.name.replace(/[^\w.-]+/g, '_')}.csv`)
        writeFileSync(join(dir, csv), toCsv(table.columns, table.rows))
        out.push({ id: sheetId, kind: 'dataset', name: `${shown} › ${sheet.name}`, file: csv, private: !shared })
      }
      if (first) out.push({ id, kind: 'document', name: shown, file, private: false })
      continue
    }
    if (kind === 'dataset') { out.push({ id, kind, name: shown, file, private: !shared }); continue }
    const text = documentText(join(dir, file))
    if (text) writeFileSync(join(dir, 'materials', `${id}.txt`), text)
    out.push({ id, kind, name: shown, file, ...(text ? { text: join('materials', `${id}.txt`) } : {}), private: false })
  }
  return out
}

export type Row = Record<string, string>

export interface ColumnProfile {
  name: string
  type: 'number' | 'category' | 'text'
  missing: number
  distinct: number
  min?: number
  max?: number
  mean?: number
  median?: number
  sd?: number
  top?: [string, number][]
}

export interface DatasetProfile { rows: number; columns: ColumnProfile[] }

const DATASET = new Set(['.csv', '.tsv', '.json', '.xlsx'])
export const kindOf = (name: string): MaterialKind => /^https?:\/\//i.test(name) ? 'link' : DATASET.has(extname(name).toLowerCase()) ? 'dataset' : 'document'

/** A delimited table, with quoted fields ("a, b") and doubled quotes inside them. */
export function parseTable(text: string, delimiter = text.split('\n', 1)[0].includes('\t') ? '\t' : ','): Row[] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) { record.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      record.push(field); field = ''
      if (record.some((v) => v !== '')) records.push(record)
      record = []
    } else field += ch
  }
  record.push(field)
  if (record.some((v) => v !== '')) records.push(record)
  const [header = [], ...body] = records
  const names = header.map((h, i) => h.trim() || `column_${i + 1}`)
  return body.map((values) => Object.fromEntries(names.map((name, i) => [name, (values[i] ?? '').trim()])))
}

export function loadDataset(path: string): Row[] {
  const text = readFileSync(path, 'utf8')
  if (extname(path).toLowerCase() === '.json') {
    const data = JSON.parse(text)
    const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : []
    return list.filter((r: unknown) => r && typeof r === 'object').map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])))
  }
  return parseTable(text, extname(path).toLowerCase() === '.tsv' ? '\t' : undefined)
}

const MISSING = new Set(['', 'na', 'n/a', 'nan', 'null', 'none', '-'])
const isMissing = (v: string | undefined) => v === undefined || MISSING.has(v.trim().toLowerCase())
const asNumber = (v: string | undefined): number | null => {
  if (isMissing(v)) return null
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
/** Sample standard deviation. */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

export function profileDataset(rows: Row[]): DatasetProfile {
  const names = rows.length ? Object.keys(rows[0]) : []
  const columns = names.map((name): ColumnProfile => {
    const values = rows.map((r) => r[name])
    const present = values.filter((v) => !isMissing(v)) as string[]
    const numbers = present.map(asNumber).filter((n): n is number => n !== null)
    const distinct = new Set(present).size
    const base = { name, missing: values.length - present.length, distinct }
    if (present.length && numbers.length === present.length && distinct > 2) {
      return { ...base, type: 'number', min: numbers.reduce((a, x) => Math.min(a, x), Infinity), max: numbers.reduce((a, x) => Math.max(a, x), -Infinity), mean: mean(numbers), median: median(numbers), sd: sd(numbers) }
    }
    const counts = new Map<string, number>()
    for (const v of present) counts.set(v, (counts.get(v) ?? 0) + 1)
    // A category repeats; a column of mostly unique values may identify people, so its values are never shown,
    // and neither is any value that occurs only once.
    const category = distinct <= 20 && distinct <= present.length / 2
    const top = category ? [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6) : undefined
    return { ...base, type: category ? 'category' : 'text', ...(top ? { top } : {}) }
  })
  return { rows: rows.length, columns }
}

/** A quantile by linear interpolation between order statistics (the common definition, type 7). */
function quantileOf(sorted: number[], p: number): number {
  const at = (sorted.length - 1) * p
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/**
 * The data as it was analysed, described by galley from the data itself, never by a model: for each dataset, every
 * numeric column's count, missing values, mean, standard deviation, median, 5th, 95th and 99th percentiles,
 * minimum and maximum. The paper prints it as an appendix, so a reader can check every number against the data.
 */
export function describeData(paper: Paper): string {
  const datasets = (paper.config.materials ?? []).filter((m) => m.kind === 'dataset')
  if (!datasets.length) return ''
  const f = (x: number) => Number.isFinite(x) ? fmt(x) : '—'
  const tables = datasets.map((m) => {
    const rows = datasetRows(paper, m)
    const columns = rows.length ? Object.keys(rows[0]) : []
    const lines: string[] = []
    for (const name of columns) {
      const values: number[] = []
      let missing = 0
      for (const r of rows) {
        const v = r[name]
        if (isMissing(v)) { missing++; continue }
        const x = asNumber(v)
        if (x === null) { values.length = 0; missing = -1; break }
        values.push(x)
      }
      if (missing < 0 || values.length < 3) continue
      const sorted = Float64Array.from(values).sort() as unknown as number[]
      lines.push(`| ${name.replace(/\|/g, '/')} | ${values.length.toLocaleString('en-US')} | ${missing.toLocaleString('en-US')} | ${f(mean(values))} | ${f(sd(values))} | ${f(quantileOf(sorted, 0.5))} | ${f(quantileOf(sorted, 0.05))} | ${f(quantileOf(sorted, 0.95))} | ${f(quantileOf(sorted, 0.99))} | ${f(sorted[0])} | ${f(sorted[sorted.length - 1])} |`)
      if (lines.length >= 15) break
    }
    if (!lines.length) return ''
    return `**${m.id}: ${m.name}**, ${rows.length.toLocaleString('en-US')} rows\n\n| Column | n | Missing | Mean | SD | Median | P5 | P95 | P99 | Min | Max |\n|:---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${lines.join('\n')}`
  }).filter(Boolean)
  if (!tables.length) return ''
  return `Each dataset as it was analysed, described by galley from the data itself: for every numeric column, the number of values, the missing values, the mean, the standard deviation, the median, the 5th, 95th and 99th percentiles, the minimum and the maximum.\n\n${tables.join('\n\n')}`
}

// Separators from 10,000 on, so a year reads as 2015, not 2,015.
const fmt = (n: number) => Math.abs(n) >= 10000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : Math.abs(n) >= 1000 ? String(Math.round(n * 10) / 10) : Number(n.toPrecision(4)).toString()

/** The profile as the models read it: no row of the data, only what describes the columns. */
export function profileText(profile: DatasetProfile): string {
  return [`${profile.rows.toLocaleString('en-US')} rows, ${profile.columns.length} columns:`,
    ...profile.columns.map((c) => c.type === 'number'
      ? `- ${c.name} (number): mean ${fmt(c.mean!)}, sd ${fmt(c.sd!)}, median ${fmt(c.median!)}, range ${fmt(c.min!)}–${fmt(c.max!)}; ${c.missing} missing`
      : `- ${c.name} (${c.type}): ${c.distinct} distinct values${c.type === 'category' && c.top?.length ? `: ${c.top.map(([v, n]) => `${v} (${n})`).join(', ')}` : ''}; ${c.missing} missing`)].join('\n')
}

const rowsCache = new Map<string, Row[]>()
export function datasetRows(paper: Paper, m: Material): Row[] {
  const path = paper.path(m.file!)
  if (!rowsCache.has(path)) rowsCache.set(path, loadDataset(path))
  return rowsCache.get(path)!
}

const upTo = (text: string, n: number) => { const w = text.split(/\s+/); return w.length > n ? `${w.slice(0, n).join(' ')} […]` : text.trim() }

/** A work's citation key, as the rest of the paper makes it (keyFor), so a dataset is cited by the key the references list. */
export function workKey(paper: Paper, workId: string): string {
  const work = paper.state.works[workId]
  if (!work.bibKey) {
    const taken = new Set(Object.values(paper.state.works).map((w) => w.bibKey).filter(Boolean) as string[])
    work.bibKey = citationKey(work, taken)
  }
  return work.bibKey
}

/** A database's schema as the models read it: its tables, largest first, with rows, size and columns; never a row of the data. */
function databaseText(paper: Paper, unit: DatasetUnit, limit = 24_000): string {
  if (!unit.schemaFile) return '  (its schema could not be read)'
  const snapshot = JSON.parse(readFileSync(paper.path(unit.schemaFile), 'utf8')) as { version?: string; tables: { table: string; rows: number; bytes: number; columns: string[]; comment?: string }[] }
  const total = snapshot.tables.reduce((a, t) => ({ rows: a.rows + t.rows, bytes: a.bytes + t.bytes }), { rows: 0, bytes: 0 })
  const lines: string[] = []
  let used = 0
  for (const t of snapshot.tables) {
    const line = `  ${t.table} (${t.rows.toLocaleString('en-US')} rows, ${(t.bytes / 2 ** 30).toFixed(2)} GiB)${t.comment ? ` -- ${t.comment}` : ''}: ${t.columns.join(', ')}`
    // A database can hold hundreds of tables: columns for as many as fit, then the rest by name. The steps that plan
    // the analysis and write the extracts read it whole.
    if (used + line.length > limit) { lines.push(`  …and ${snapshot.tables.length - lines.length} more tables: ${snapshot.tables.slice(lines.length).map((x) => x.table).join(', ')}`); break }
    lines.push(line)
    used += line.length
  }
  return `  ClickHouse${snapshot.version ? ` ${snapshot.version}` : ''}, database "${unit.database}": ${snapshot.tables.length} tables, ${total.rows.toLocaleString('en-US')} rows, ${(total.bytes / 2 ** 30).toFixed(1)} GiB. Read-only: the analysis takes from it only the extracts it needs, each a SQL query galley runs (aggregated in the database, at most 1,000,000 rows), and no row of it reaches a model unless an extract is shared.\n  Tables, largest first:\n${lines.join('\n')}`
}

/** How the paper may describe a dataset, from where it comes. */
function provenance(paper: Paper, unit: DatasetUnit): string {
  const sources = datasetSources(paper, unit)
  const cite = [
    sources.data ? `cite the dataset as [@${workKey(paper, sources.data)}]` : '',
    sources.article ? `cite the publication that first reported it as [@${workKey(paper, sources.article)}]` : '',
  ].filter(Boolean).join(', and ')
  const published = !!(unit.doi || unit.url || unit.describedIn)
  const origin = unit.producedBy === 'others'
    ? 'produced by others: the paper analyses it and describes it as their data, never as measurements the authors made'
    : published
      ? 'produced by the authors and published before: the paper describes it as their earlier data, never as measurements made for this paper'
      : 'produced by the authors: their own work'
  return `${origin}.${unit.licence ? ` Licence: ${unit.licence}.` : ''}${unit.citation ? ` Its producers ask that it be cited as: ${unit.citation}.` : ''}${cite ? ` Where the paper describes the data, ${cite}.` : ''}`
}

/** The materials as the seats read them: a private dataset only as its profile, never a row of it; a dataset unit with where it comes from. */
export function materialsBlock(paper: Paper, options: { fullSchema?: boolean } = {}): string {
  const list = paper.config.materials ?? []
  // A database with no extracts yet still shows its schema, so the analysis can be planned on it.
  if (!list.length && !(paper.config.datasets ?? []).some((u) => u.connection)) return ''
  const describe = (m: Material) => {
    if (m.kind === 'dataset') {
      const rows = datasetRows(paper, m)
      const profile = profileText(profileDataset(rows)).split('\n').map((l) => `  ${l}`).join('\n')
      const sample = m.private ? '' : `\n  First rows:\n${rows.slice(0, 15).map((r) => `  ${JSON.stringify(r)}`).join('\n')}`
      return `[${m.id}] dataset "${m.name}"${m.private ? " (private: the data stays on the authors' machine; this is its profile)" : ''}\n${profile}${sample}`
    }
    const text = m.text ? readFileSync(paper.path(m.text), 'utf8') : ''
    const label = m.kind === 'link' ? `link ${m.url}` : `document "${m.name}"`
    return `[${m.id}] ${label}${text ? `:\n"""\n${upTo(text, m.kind === 'link' ? 2000 : 2500)}\n"""` : ' (its text could not be read)'}`
  }
  const units = paper.config.datasets ?? []
  const parts = [
    ...units.map((u) => u.connection
      ? `[${u.id}] DATABASE "${u.name}", ${provenance(paper, u)}\n${databaseText(paper, u, options.fullSchema ? Infinity : undefined)}${list.some((m) => m.dataset === u.id) ? `\n  Its extracts so far:\n${list.filter((m) => m.dataset === u.id).map(describe).join('\n\n')}` : ''}`
      : `[${u.id}] DATASET "${u.name}"${u.version ? `, version ${u.version}` : ''}, ${provenance(paper, u)} Its files:\n${list.filter((m) => m.dataset === u.id).map(describe).join('\n\n')}`),
    ...list.filter((m) => !m.dataset).map(describe),
  ]
  return `THE MATERIALS the paper draws on besides the literature. Data the authors produced for this paper is their own work; a dataset produced by others, or published before, is described and cited as its provenance below says.\n${parts.join('\n\n')}`
}

/** The data availability statement, from each dataset's provenance: where it is, or that it is not public. */
export function availabilityStatement(paper: Paper): string {
  const units = paper.config.datasets ?? []
  return units.map((u) => {
    if (u.connection) return `The data come from the ${u.private ? 'private ' : ''}database "${u.name}" (ClickHouse), ${u.producedBy === 'others' ? 'kept by others' : 'kept by the authors'}${u.private ? ', which is not publicly available' : ''}; the query that extracted each table the analyses used is in the evidence package, so anyone with access to the database can extract them again.`
    const sources = datasetSources(paper, u)
    const where = sources.data ? ` It is available at ${u.doi ? `https://doi.org/${u.doi}` : u.url} [@${workKey(paper, sources.data)}].` : u.private ? ' It is not publicly available.' : ''
    const first = sources.article ? ` It was first reported in [@${workKey(paper, sources.article)}].` : ''
    const who = u.producedBy === 'others' ? 'was produced by others' : 'was produced by the authors'
    return `The dataset "${u.name}"${u.version ? ` (version ${u.version})` : ''} ${who}.${where}${first}${u.licence ? ` Licence: ${u.licence}.` : ''}`
  }).join(' ')
}

/** What galley measured in the authors' datasets, for every seat that writes or judges the paper. */
export function measurementsBlock(paper: Paper): string {
  const ms = Object.values(paper.state.measurements ?? {})
  if (!ms.length) return ''
  const a = paper.state.analysis
  const checks = a?.runs ? Object.entries(a.runs).flatMap(([id, r]) => r.ok ? r.checks.map((c) => `${id}: ${c.assumption}: ${c.holds ? 'holds' : 'does not hold'} (${c.method}${c.p !== undefined ? `, p = ${c.p.toPrecision(2)}` : ''}). ${c.note}`) : []) : []
  const how = a?.mode === 'code'
    ? `\nHow they were computed: each analysis below ran as code on the authors' machine, as planned${a.reviewed ? ' and reviewed by a statistician' : ''}, for a paper in ${a.field || 'its field'}. The field's conventions: ${a.conventions.join(' ')}\n${a.prepare?.ok && a.prepare.report ? `The shared preparation every analysis started from, as it ran (the paper reports each exclusion with its count):\n${a.prepare.report.steps.map((st) => `- ${st.step}${st.rows_before !== undefined && st.rows_after !== undefined ? ` (${st.rows_before} rows to ${st.rows_after})` : ''}: ${st.note}`).join('\n')}\nShared definitions: ${a.prepare.report.definitions.join(' ')}` : `Preparation applied first: ${a.preparation.join(' ') || 'none'}`}\nThe analyses: ${a.plan.filter((p) => a.runs?.[p.id]?.ok).map((p) => `${p.id} ${p.question} (method: ${p.method}; uncertainty: ${p.uncertainty})`).join('; ')}`
    : ''
  return `MEASUREMENTS computed on the authors' machine from their datasets. A number from the data appears in the text only as its placeholder, {{data.<id>}} (for example {{data.A1}}), with its interval as {{data.<id>.ci}} where it has one and its n as {{data.<id>.n}}; they are filled in when the paper is typeset, so never write them as figures. The paper states each number with its n, and with its interval when it has one.${how}
${ms.map((m) => `${m.id}: ${m.summary}${m.ci ? ` [interval: {{data.${m.id}.ci}}]` : ''}`).join('\n')}${checks.length ? `\nASSUMPTION CHECKS, which the paper reports where it uses the analysis, with what follows when one does not hold:\n${checks.join('\n')}` : ''}${a?.notComputed?.length ? `\nPLANNED BUT NOT COMPUTED. These did not run, so the paper never describes them, their methods or their results, and never says the paper reports them: ${a.notComputed.map((n) => `${n.id} (${n.question})`).join('; ')}.` : ''}
The methods describe only the analyses above, with the methods, intervals and checks recorded here; never describe an analysis, an interval, a model fit or a check that is not listed.`
}

// ---------------------------------------------------------------- analyses

export type Op = 'count' | 'mean' | 'median' | 'sd' | 'min' | 'max' | 'quantile' | 'share' | 'proportion' | 'group_count' | 'group_mean' | 'correlation' | 'mean_difference'

export interface Filter { column: string; op: 'eq' | 'ne' | 'gt' | 'lt' | 'in'; value: string }

export interface AnalysisSpec {
  id: string
  dataset: string
  op: Op
  /** The column measured (for correlation, the first of two). */
  column: string | null
  column2: string | null
  /** For a group op or a mean difference: the column that splits the rows. */
  by: string | null
  /** For proportion: the value counted; for mean_difference: "groupA|groupB". */
  value: string | null
  where: Filter | null
}

export interface Measurement {
  id: string
  /** The built-in operation that computed it; a result of analysis code has none. */
  spec?: AnalysisSpec
  /** The planned analysis whose code printed it, and the name it printed it under. */
  analysis?: string
  name?: string
  /** The number a sentence cites, as text, filled in for {{data.<id>}}. */
  value: string
  /** Its confidence interval as text ("95% CI 400 ms to 437 ms"), filled in for {{data.<id>.ci}}. */
  ci?: string
  /** The full result in words, for the author and the evidence package. */
  summary: string
  n: number
  error?: string
}

function keep(rows: Row[], where: Filter | null): Row[] {
  if (!where) return rows
  return rows.filter((r) => {
    const v = r[where.column] ?? ''
    const x = asNumber(v)
    const y = asNumber(where.value)
    switch (where.op) {
      case 'eq': return v === where.value
      case 'ne': return v !== where.value
      case 'gt': return x !== null && y !== null && x > y
      case 'lt': return x !== null && y !== null && x < y
      case 'in': return where.value.split('|').includes(v)
    }
  })
}

const numbersOf = (rows: Row[], column: string) => rows.map((r) => asNumber(r[column])).filter((n): n is number => n !== null)

/** The regularized incomplete beta function, by its continued fraction (Numerical Recipes, betacf). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lgamma = (z: number): number => {
    const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
    let y = z
    const tmp = z + 5.5 - (z + 0.5) * Math.log(z + 5.5)
    let ser = 1.000000000190015
    for (const c of g) ser += c / ++y
    return -tmp + Math.log(2.5066282746310005 * ser / z)
  }
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  const cf = (xx: number, aa: number, bb: number) => {
    let c = 1, d = 1 - (aa + bb) * xx / (aa + 1)
    if (Math.abs(d) < 1e-30) d = 1e-30
    d = 1 / d
    let h = d
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m
      let num = m * (bb - m) * xx / ((aa + m2 - 1) * (aa + m2))
      d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; h *= d * c
      num = -(aa + m) * (aa + bb + m) * xx / ((aa + m2) * (aa + m2 + 1))
      d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d
      const del = d * c
      h *= del
      if (Math.abs(del - 1) < 3e-12) break
    }
    return h
  }
  return x < (a + 1) / (a + b + 2) ? front * cf(x, a, b) / a : 1 - front * cf(1 - x, b, a) / b
}

/** Two-sided p-value of a t statistic with df degrees of freedom. */
export const tTestP = (t: number, df: number) => incompleteBeta(df / (df + t * t), df / 2, 0.5)

const pText = (p: number) => p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`

/** Compute one analysis on this machine. Nothing here calls a model. */
export function analyze(rows: Row[], spec: AnalysisSpec): Measurement {
  const data = keep(rows, spec.where)
  const scope = spec.where ? ` where ${spec.where.column} ${spec.where.op} ${spec.where.value}` : ''
  const fail = (error: string): Measurement => ({ id: spec.id, spec, value: '[not computable]', summary: error, n: data.length, error })
  const col = spec.column ?? ''
  try {
    switch (spec.op) {
      case 'count':
        return { id: spec.id, spec, value: data.length.toLocaleString('en-US'), summary: `${data.length.toLocaleString('en-US')} rows${scope}`, n: data.length }
      case 'mean': case 'median': case 'sd': case 'min': case 'max': {
        const xs = numbersOf(data, col)
        if (!xs.length) return fail(`no numeric values in ${col}${scope}`)
        // Loops, not spreads: a measurement column can hold hundreds of thousands of values.
        const v = spec.op === 'mean' ? mean(xs) : spec.op === 'median' ? median(xs) : spec.op === 'sd' ? sd(xs) : spec.op === 'min' ? xs.reduce((a, x) => Math.min(a, x), Infinity) : xs.reduce((a, x) => Math.max(a, x), -Infinity)
        const extra = spec.op === 'mean' ? ` (sd ${fmt(sd(xs))})` : ''
        return { id: spec.id, spec, value: fmt(v), summary: `${spec.op} of ${col}${scope}: ${fmt(v)}${extra}, n = ${xs.length}`, n: xs.length }
      }
      case 'quantile': {
        const xs = numbersOf(data, col).sort((a, b) => a - b)
        const raw = Number(String(spec.value ?? '').replace('%', ''))
        const p = raw > 1 ? raw / 100 : raw
        if (!xs.length) return fail(`no numeric values in ${col}${scope}`)
        if (!(p >= 0 && p <= 1)) return fail(`the probability ${spec.value} is not between 0 and 1`)
        // Linear interpolation between order statistics (the usual sample quantile).
        const h = (xs.length - 1) * p
        const v = xs[Math.floor(h)] + (h - Math.floor(h)) * ((xs[Math.ceil(h)] ?? xs[Math.floor(h)]) - xs[Math.floor(h)])
        const label = `${fmt(100 * p)}th percentile`
        return { id: spec.id, spec, value: fmt(v), summary: `${label} of ${col}${scope}: ${fmt(v)}, n = ${xs.length}`, n: xs.length }
      }
      case 'share': {
        const m = String(spec.value ?? '').trim().match(/^(<=|>=|<|>|=)\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)$/i)
        if (!m) return fail(`the threshold ${spec.value} is not like <700 or >=1300`)
        const xs = numbersOf(data, col)
        if (!xs.length) return fail(`no numeric values in ${col}${scope}`)
        const limit = Number(m[2])
        const meets = (x: number) => m[1] === '<' ? x < limit : m[1] === '<=' ? x <= limit : m[1] === '>' ? x > limit : m[1] === '>=' ? x >= limit : x === limit
        const hits = xs.filter(meets).length
        const pct = (100 * hits) / xs.length
        return { id: spec.id, spec, value: `${fmt(pct)}%`, summary: `share of ${col} ${m[1]} ${m[2]}${scope}: ${fmt(pct)}% (${hits} of ${xs.length})`, n: xs.length }
      }
      case 'proportion': {
        const present = data.filter((r) => !isMissing(r[col]))
        if (!present.length) return fail(`no values in ${col}${scope}`)
        const hits = present.filter((r) => r[col] === spec.value).length
        const pct = (100 * hits) / present.length
        return { id: spec.id, spec, value: `${fmt(pct)}%`, summary: `${col} = ${spec.value}${scope}: ${fmt(pct)}% (${hits} of ${present.length})`, n: present.length }
      }
      case 'group_count': case 'group_mean': {
        const by = spec.by ?? ''
        const groups = new Map<string, Row[]>()
        for (const r of data) if (!isMissing(r[by])) groups.set(r[by], [...(groups.get(r[by]) ?? []), r])
        if (!groups.size) return fail(`no values in ${by}${scope}`)
        const parts = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([g, rs]) => {
          if (spec.op === 'group_count') return `${g}: ${rs.length}`
          const xs = numbersOf(rs, col)
          return `${g}: ${xs.length ? `${fmt(mean(xs))} (sd ${fmt(sd(xs))}, n = ${xs.length})` : 'no values'}`
        })
        const what = spec.op === 'group_count' ? `rows by ${by}` : `mean ${col} by ${by}`
        return { id: spec.id, spec, value: parts.join('; '), summary: `${what}${scope}: ${parts.join('; ')}`, n: data.length }
      }
      case 'correlation': {
        const pairs = data.map((r) => [asNumber(r[col]), asNumber(r[spec.column2 ?? ''])] as const).filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null)
        if (pairs.length < 3) return fail(`fewer than 3 rows with both ${col} and ${spec.column2}`)
        const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1])
        const mx = mean(xs), my = mean(ys)
        const sxy = pairs.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0)
        const r = sxy / Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0))
        const t = r * Math.sqrt((pairs.length - 2) / Math.max(1e-12, 1 - r * r))
        const p = tTestP(t, pairs.length - 2)
        return { id: spec.id, spec, value: `r = ${r.toFixed(2)}`, summary: `Pearson correlation of ${col} and ${spec.column2}${scope}: r = ${r.toFixed(3)}, n = ${pairs.length}, ${pText(p)}`, n: pairs.length }
      }
      case 'mean_difference': {
        const [a, b] = (spec.value ?? '').split('|')
        const xa = numbersOf(data.filter((r) => r[spec.by ?? ''] === a), col)
        const xb = numbersOf(data.filter((r) => r[spec.by ?? ''] === b), col)
        if (xa.length < 2 || xb.length < 2) return fail(`need at least 2 values of ${col} in each of ${a} and ${b}`)
        const va = sd(xa) ** 2 / xa.length, vb = sd(xb) ** 2 / xb.length
        const diff = mean(xa) - mean(xb)
        const t = diff / Math.sqrt(va + vb)
        const df = (va + vb) ** 2 / (va ** 2 / (xa.length - 1) + vb ** 2 / (xb.length - 1))
        const p = tTestP(t, df)
        return { id: spec.id, spec, value: fmt(diff), summary: `mean ${col}, ${a} minus ${b}${scope}: ${fmt(diff)} (${fmt(mean(xa))} vs ${fmt(mean(xb))}; n = ${xa.length} and ${xb.length}; Welch t = ${t.toFixed(2)}, df = ${df.toFixed(1)}, ${pText(p)})`, n: xa.length + xb.length }
      }
    }
  } catch (error) {
    return fail((error as Error).message)
  }
}
