import { splitTableRow } from '../markdown/syntax.js'

// Column weights for the shared grid template. Every row of a table is
// its own grid container — they are sibling line divs, and wrapping
// them in one element would break the flat line model the whole editor
// is built on — so the columns only line up if each row is handed the
// same explicit track list.
//
// Widths come from the longest cell in each column, measured in
// characters. That is deliberate: measuring rendered boxes would mean
// a layout read on every keystroke, and a character count is stable,
// cheap, and close enough for prose. The clamp keeps a `Yes`/`No`
// column from collapsing to a sliver and a paragraph-in-a-cell from
// starving its neighbours.
export const TABLE_COL_MIN = 4
export const TABLE_COL_MAX = 24

export function tableColumnTemplate(rows: string[]): string {
  const widths: number[] = []
  for (const row of rows) {
    const parts = splitTableRow(row)
    if (!parts) continue
    parts.cells.forEach((cell, i) => {
      const len = cell.length
      if (widths[i] === undefined || len > widths[i]) widths[i] = len
    })
  }
  if (widths.length === 0) return ''
  return widths
    .map((w) => `minmax(0, ${Math.max(TABLE_COL_MIN, Math.min(TABLE_COL_MAX, w))}fr)`)
    .join(' ')
}

export interface CellSpan { start: number, end: number }

// Where each cell's content sits in the row's source text. Offsets are
// textContent coordinates, the same ones the caret helpers speak.
export function tableCellSpans(text: string): CellSpan[] {
  const parts = splitTableRow(text)
  if (!parts) return []
  const spans: CellSpan[] = []
  let at = 0
  parts.markers.forEach((marker, i) => {
    at += marker.length
    if (i < parts.cells.length) {
      spans.push({ start: at, end: at + parts.cells[i].length })
      at += parts.cells[i].length
    }
  })
  return spans
}
