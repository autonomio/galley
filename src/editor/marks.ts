// Drawing on top of the page: note underlines, and transient highlights.
// Marks are absolutely positioned rects in page-local coordinates, one per
// Range.getClientRects() result, so they follow wrapped and multi-line
// passages. They are redrawn after every edit and on resize.
import { reAnchor } from '../core/anchoring.js'
import { textNodeAtOffset } from '../surface/caret.js'
import type { Surface } from '../surface/surface.js'
import type { Annotation } from '../types.js'

/** Page-local rects for a DOM range, skipping zero-width fragments. */
export function pageRects(page: HTMLElement, range: Range, minWidth = 0.5): DOMRect[] {
  const box = page.getBoundingClientRect()
  return Array.from(range.getClientRects())
    .filter((rect) => rect.width >= minWidth || rect.height >= minWidth)
    .map((rect) => new DOMRect(rect.left - box.left, rect.top - box.top, rect.width, rect.height))
}

function mark(className: string, rect: DOMRect): HTMLDivElement {
  const div = document.createElement('div')
  div.className = className
  div.style.left = `${rect.x}px`
  div.style.top = `${rect.y}px`
  div.style.width = `${rect.width}px`
  div.style.height = `${rect.height}px`
  return div
}

// A DOM Range from an annotation's stored line + offset pairs, or null when
// a line is out of bounds (treated as orphaned by the caller).
function rangeForAnnotation(lines: HTMLElement[], a: Annotation): Range | null {
  const startLine = lines[a.range.start_line]
  const endLine = lines[a.range.end_line]
  if (!startLine || !endLine) return null
  const start = textNodeAtOffset(startLine, a.range.start_offset)
  const end = textNodeAtOffset(endLine, a.range.end_offset)
  if (!start || !end) return null
  try {
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    return range
  } catch {
    return null
  }
}

/** Where a note's marks begin on the page: its passage's first line, or for a gone passage the line it was last seen on. */
export interface NotePlace {
  top: number
  left: number
  orphan: boolean
}

/**
 * Re-anchor every note and draw its marks. Notes that moved get their new
 * range (and `moved` is called so they are saved); notes whose passage is
 * gone draw as an inert tick on the line they were last seen on. Returns
 * where each note's marks begin.
 */
export function renderAnnotationMarks(options: {
  layer: HTMLElement
  page: HTMLElement
  surface: Surface
  annotations: Annotation[]
  moved(): void
}): Map<string, NotePlace> {
  const { layer, page, surface, annotations } = options
  layer.innerHTML = ''
  const places = new Map<string, NotePlace>()
  const orphans = new Set<string>()
  if (!annotations.length) return places
  const lineEls = surface.lines()
  const texts = lineEls.map((line) => line.textContent || '')

  let anyChanged = false
  for (const a of annotations) {
    const fresh = reAnchor(a, texts, annotations)
    if (!fresh) { orphans.add(a.id); continue }
    if (fresh.start_line !== a.range.start_line || fresh.start_offset !== a.range.start_offset
        || fresh.end_line !== a.range.end_line || fresh.end_offset !== a.range.end_offset) {
      a.range = fresh
      a.updated_at = new Date().toISOString()
      anyChanged = true
    }
  }
  if (anyChanged) options.moved()

  const box = page.getBoundingClientRect()
  // Orphans draw first, as short inert ticks at the start of the line they
  // were last seen on, so a live mark on the same line paints over them.
  // Orphans sharing a line cascade rightward, one tick each: identical boxes
  // would stack and leave all but the top one unreachable.
  // A tick is one line of text square, not the line element's height: a
  // paragraph wrapped over twenty lines made each tick hundreds of pixels
  // wide, the cascade ran far past the page, and the page scrolled sideways.
  // For the same reason the cascade wraps at the line's right edge.
  const orphansOnLine = new Map<number, number>()
  for (const a of annotations) {
    if (!orphans.has(a.id)) continue
    const lineIdx = Math.max(0, Math.min(a.range.start_line, lineEls.length - 1))
    const lineEl = lineEls[lineIdx]
    if (!lineEl) continue
    const slot = orphansOnLine.get(lineIdx) ?? 0
    orphansOnLine.set(lineIdx, slot + 1)
    const rect = lineEl.getBoundingClientRect()
    const size = Math.min(rect.height, parseFloat(getComputedStyle(lineEl).lineHeight) || rect.height)
    const perRow = Math.max(1, Math.floor(rect.width / size) || 1)
    const tick = new DOMRect(rect.left - box.left + (slot % perRow) * size, rect.top - box.top + Math.floor(slot / perRow) * size, size, size)
    const div = mark('galley-mark is-orphan', tick)
    div.dataset.annotation = a.id
    div.title = a.comment ? `Passage changed: ${a.comment.slice(0, 200)}` : 'Passage changed'
    layer.appendChild(div)
    places.set(a.id, { top: tick.y, left: tick.x, orphan: true })
  }

  for (const a of annotations) {
    if (orphans.has(a.id)) continue
    const range = rangeForAnnotation(lineEls, a)
    if (!range) continue
    for (const rect of pageRects(page, range)) {
      if (rect.width < 0.5) continue
      // A settled thread stays findable but stops asking for attention.
      const div = mark(a.resolved ? 'galley-mark is-resolved' : 'galley-mark', rect)
      div.dataset.annotation = a.id
      div.title = a.comment ? a.comment.slice(0, 200) : 'Comment'
      layer.appendChild(div)
      if (!places.has(a.id)) places.set(a.id, { top: rect.y, left: rect.x, orphan: false })
    }
  }
  // A passage with nothing to underline (only hidden markers) still has a place: its line.
  for (const a of annotations) {
    const line = places.has(a.id) ? null : lineEls[Math.max(0, Math.min(a.range.start_line, lineEls.length - 1))]
    if (!line) continue
    const rect = line.getBoundingClientRect()
    places.set(a.id, { top: rect.top - box.top, left: rect.left - box.left, orphan: orphans.has(a.id) })
  }
  return places
}

/** Replace the layer's highlight with `range`, and bring it into view. */
export function drawHighlight(layer: HTMLElement, page: HTMLElement, range: Range): void {
  layer.innerHTML = ''
  let first: HTMLElement | null = null
  for (const rect of pageRects(page, range)) {
    const div = mark('galley-highlight', new DOMRect(rect.x, rect.y, Math.max(rect.width, 2), rect.height))
    layer.appendChild(div)
    first ??= div
  }
  first?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
