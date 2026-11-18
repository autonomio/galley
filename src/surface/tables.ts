// Moving around a table. A table is a run of sibling line elements, so
// these helpers step between rows and cells in source-offset coordinates.
import { tableCellSpans } from '../core/tables.js'
import { isTableRowKind, kindOf } from './render.js'
import { setCursorOffsetInLine } from './caret.js'

function isDelimiterLine(el: HTMLElement): boolean {
  return el.dataset.kind === 'table-delim' || el.dataset.kind === 'source'
}

export function isTableLine(el: Element | null): boolean {
  const kind = (el as HTMLElement | null)?.dataset?.kind
  return kind === 'table-head' || kind === 'table-row'
    || kind === 'table-delim' || kind === 'source'
}

// The next / previous line that holds cells, stepping over the delimiter
// row (which sits between the header and the first body row and has no
// cells of its own).
export function nextTableRowLine(line: HTMLElement): HTMLElement | null {
  let el = line.nextElementSibling as HTMLElement | null
  while (el && isDelimiterLine(el)) el = el.nextElementSibling as HTMLElement | null
  return el && isTableRowKind(kindOf(el)) ? el : null
}

export function prevTableRowLine(line: HTMLElement): HTMLElement | null {
  let el = line.previousElementSibling as HTMLElement | null
  while (el && isDelimiterLine(el)) el = el.previousElementSibling as HTMLElement | null
  return el && isTableRowKind(kindOf(el)) ? el : null
}

export function lastTableLineOf(line: HTMLElement): HTMLElement {
  let el = line
  while (isTableLine(el.nextElementSibling)) el = el.nextElementSibling as HTMLElement
  return el
}

export function placeCaretInTableCell(line: HTMLElement, index: number, at: 'start' | 'end' = 'start'): void {
  const spans = tableCellSpans(line.textContent || '')
  const span = spans[index]
  setCursorOffsetInLine(line, span ? (at === 'start' ? span.start : span.end) : (line.textContent || '').length)
}

// Is the caret on the cell's first (up) or last (down) visual line? A
// cell whose text has wrapped has line boxes of its own to move through
// before "down" can mean the next row.
//
// The comparison is against the text's own line fragments rather than
// the cell's box: a caret rect is only as tall as the glyphs, while the
// box adds padding and the full line-height on top. Half a line of
// tolerance absorbs the small differences between a caret and an inline
// run of another size, such as a `code` span.
export function caretAtCellEdge(range: Range, cell: HTMLElement, down: boolean): boolean {
  const caret = range.getBoundingClientRect()
  // A caret in an empty cell has no rect to measure; it is on the only
  // line the cell has, which is both its first and its last.
  if (caret.height === 0) return true
  const probe = document.createRange()
  probe.selectNodeContents(cell)
  const rects = Array.from(probe.getClientRects()).filter((r) => r.height > 0)
  if (rects.length === 0) return true
  const slack = (parseFloat(getComputedStyle(cell).lineHeight) || caret.height) / 2
  return down
    ? caret.bottom >= Math.max(...rects.map((r) => r.bottom)) - slack
    : caret.top <= Math.min(...rects.map((r) => r.top)) + slack
}
