// Excel workbooks as datasets. An .xlsx file is a zip of XML parts; galley reads
// them with the system's unzip, with no library. Measurement workbooks often keep
// raw columns beside summary tables and charts, so each sheet becomes a table of
// its data columns: a column whose numbers run on long enough to be measurements,
// named by the label above them.
import { execFileSync } from 'node:child_process'

export interface Sheet {
  name: string
  /** Cell text by row and column; missing cells are empty strings. */
  rows: string[][]
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e.toLowerCase()])

function part(path: string, entry: string): string | null {
  try { return execFileSync('unzip', ['-p', path, entry], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8') } catch { return null }
}

const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('')

/** Column letters to a zero-based index: A is 0, Z is 25, AA is 26. */
export function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A'
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
}

export const columnLetters = (index: number): string => {
  let n = index + 1
  let out = ''
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26) }
  return out
}

/** Every sheet of a workbook, in its own order, with the text of each cell (a formula gives its last computed value). */
export function readWorkbook(path: string): Sheet[] {
  const workbook = part(path, 'xl/workbook.xml')
  const rels = part(path, 'xl/_rels/workbook.xml.rels')
  if (!workbook || !rels) throw new Error(`${path} is not an Excel workbook (.xlsx)`)
  const strings = [...(part(path, 'xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [m[0].match(/\bId="([^"]+)"/)?.[1] ?? '', m[0].match(/\bTarget="([^"]+)"/)?.[1] ?? '']))
  const sheets: Sheet[] = []
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(m[0].match(/\bname="([^"]*)"/)?.[1] ?? `Sheet${sheets.length + 1}`)
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1] ?? ''
    const file = (target.get(rid) ?? '').replace(/^\//, '')
    const xml = part(path, file.startsWith('xl/') ? file : `xl/${file}`)
    if (!xml) continue
    const rows: string[][] = []
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const r = Number(row[1].match(/\br="(\d+)"/)?.[1] ?? rows.length + 1) - 1
      const cells: string[] = []
      for (const c of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]
        const ref = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1]
        const at = ref ? columnIndex(ref) : cells.length
        const type = attrs.match(/\bt="([^"]+)"/)?.[1]
        const body = c[2] ?? ''
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        cells[at] = type === 's' && v !== undefined ? strings[Number(v)] ?? '' : type === 'inlineStr' ? textOf(body) : v !== undefined ? decode(v) : ''
      }
      rows[r] = Array.from(cells, (x) => x ?? '')
    }
    sheets.push({ name, rows: Array.from(rows, (x) => x ?? []) })
  }
  return sheets
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i
const isNumber = (s: string | undefined) => !!s && NUMBER.test(s.trim())

/** The longest a run of numbers can be and still be a summary table rather than measurements. */
export const MIN_SERIES = 30

/**
 * A sheet's data columns as one table: each column's longest run of numbers that
 * is at least MIN_SERIES long, named by the nearest label above it (or its column
 * letter). Summary blocks, histogram bins shorter than that, and charts' scraps
 * are left out. Returns null for a sheet with no such column.
 */
export function sheetTable(sheet: Sheet): { columns: string[]; rows: Record<string, string>[] } | null {
  // A loop, not a spread: a sheet can hold hundreds of thousands of rows.
  const width = sheet.rows.reduce((w, r) => Math.max(w, r.length), 0)
  const found: { name: string; values: string[] }[] = []
  for (let c = 0; c < width; c++) {
    let best: { start: number; end: number } | null = null
    let start = -1
    for (let r = 0; r <= sheet.rows.length; r++) {
      const cell = sheet.rows[r]?.[c]
      if (r < sheet.rows.length && isNumber(cell)) { if (start < 0) start = r; continue }
      if (start >= 0 && (!best || r - start > best.end - best.start)) best = { start, end: r }
      start = -1
    }
    if (!best || best.end - best.start < MIN_SERIES) continue
    let label = ''
    for (let r = best.start - 1; r >= 0 && !label; r--) {
      const cell = (sheet.rows[r]?.[c] ?? '').trim()
      if (cell && !isNumber(cell)) label = cell
    }
    found.push({ name: label || columnLetters(c), values: sheet.rows.slice(best.start, best.end).map((r) => (r[c] ?? '').trim()) })
  }
  if (!found.length) return null
  const seen = new Map<string, number>()
  const columns = found.map((f, i) => {
    const count = (seen.get(f.name) ?? 0) + 1
    seen.set(f.name, count)
    return found.filter((g) => g.name === f.name).length > 1 ? `${f.name} (${count})` : f.name || `column ${i + 1}`
  })
  const length = Math.max(...found.map((f) => f.values.length))
  const rows = Array.from({ length }, (_, r) => Object.fromEntries(columns.map((name, i) => [name, found[i].values[r] ?? ''])))
  return { columns, rows }
}

const csvCell = (s: string) => /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s

export function toCsv(columns: string[], rows: Record<string, string>[]): string {
  return [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c] ?? '')).join(','))].join('\n') + '\n'
}
