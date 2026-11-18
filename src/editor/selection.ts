// The floating actions shown while text is selected: Comment, and whatever
// the host adds. They sit in the margin beside the writing column, never
// over the prose.
import type { AnnotationRange } from '../types.js'
import { rangeText } from '../core/anchoring.js'
import { offsetInLineFor, selectionIn } from '../surface/caret.js'
import type { Surface } from '../surface/surface.js'
import { el } from './dom.js'

export interface SelectedPassage {
  /** The passage's source text, markers included. */
  text: string
  range: AnnotationRange
  /** Where it was on screen when the action was pressed. */
  rect: DOMRect
}

export interface ClusterAction {
  id: string
  label: string
  icon: string
  run(passage: SelectedPassage): void
}

/** The current selection inside the surface, in source coordinates. */
export function selectedPassage(surface: Surface): SelectedPassage | null {
  const docEl = surface.element
  const range = selectionIn(docEl)
  if (!range || range.collapsed) return null
  const lines = surface.lines()
  const locate = (node: Node, off: number): { line: number, offset: number } | null => {
    let l: Node | null = node
    while (l && l.parentNode !== docEl) l = l.parentNode
    if (!l) return null
    const lineIdx = lines.indexOf(l as HTMLElement)
    if (lineIdx < 0) return null
    return { line: lineIdx, offset: offsetInLineFor(l as HTMLElement, node, off) }
  }
  const s = locate(range.startContainer, range.startOffset)
  const e = locate(range.endContainer, range.endOffset)
  if (!s || !e) return null
  if (s.line > e.line || (s.line === e.line && s.offset >= e.offset)) return null
  const span = { start_line: s.line, start_offset: s.offset, end_line: e.line, end_offset: e.offset }
  const text = rangeText(lines.map((line) => line.textContent || ''), span)
  return text === null ? null : { text, range: span, rect: range.getBoundingClientRect() }
}

// Geometry of the cluster: button size matches .galley-selection-btn; the gap
// and margin are the breathing room between buttons and from the column.
const BTN = 24
const GAP = 4
const MARGIN = 12
const EDGE = 4

export interface SelectionCluster {
  readonly element: HTMLElement
  update(): void
  hide(): void
  /** Hold the cluster hidden while something else has the writer's focus. */
  suppress(suppressed: boolean): void
}

export function createSelectionCluster(options: {
  surface: Surface
  column: HTMLElement
  /** The visible area: the cluster stays inside it. */
  viewport(): { top: number, bottom: number }
  actions: ClusterAction[]
}): SelectionCluster {
  const element = el('div', { class: 'galley-selection' })
  const buttons = options.actions.map((action) => {
    const button = el('button', {
      type: 'button',
      class: 'galley-selection-btn',
      'data-action': action.id,
      'aria-label': action.label,
      title: action.label,
    }, action.icon)
    button.hidden = true
    // mousedown, not click: act before the editor sees the click and
    // collapses the selection.
    button.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const passage = selectedPassage(options.surface)
      if (!passage) return
      hide()
      action.run(passage)
    })
    element.appendChild(button)
    return button
  })
  let suppressed = false

  function hide(): void {
    for (const button of buttons) button.hidden = true
  }

  // Show the cluster for the live selection. getClientRects is
  // viewport-relative and the buttons are position:fixed, so a rect IS the
  // coordinate.
  function update(): void {
    if (suppressed || !buttons.length) { hide(); return }
    const range = selectionIn(options.surface.element)
    if (!range || range.collapsed) { hide(); return }
    const rects = range.getClientRects()
    if (rects.length === 0) { hide(); return }
    const first = rects[0]
    const last = rects[rects.length - 1]
    const n = buttons.length
    const view = options.viewport()

    // Pinned to the column's edge the cluster has one predictable home and
    // the passage stays legible while the writer decides. Anchored to the
    // selection's end it covered the very text being acted on.
    const column = options.column.getBoundingClientRect()
    const rowWidth = n * BTN + (n - 1) * GAP
    const stackHeight = n * BTN + (n - 1) * GAP

    // Vertically: level with the selection's first line, kept inside view.
    const preferredTop = first.top + (first.height - BTN) / 2
    const top = Math.max(view.top + MARGIN, Math.min(preferredTop, view.bottom - BTN - MARGIN))

    // Horizontally: a row in the right margin, else the left; a vertical
    // stack where a row does not fit; under the selection when the column
    // fills the window.
    const rightRow = column.right + MARGIN
    const leftRow = column.left - MARGIN - rowWidth
    const fitsRight = rightRow + rowWidth <= window.innerWidth - MARGIN
    const fitsLeft = leftRow >= MARGIN
    const rightStack = Math.min(column.right + MARGIN, window.innerWidth - BTN - EDGE)
    const leftStack = Math.max(column.left - MARGIN - BTN, EDGE)
    const stacksRight = rightStack >= column.right + EDGE
    const stacksLeft = leftStack + BTN <= column.left - EDGE

    let left: number
    let vertical = false
    let below = false
    if (fitsRight) left = rightRow
    else if (fitsLeft) left = leftRow
    else if (stacksRight) { left = rightStack; vertical = true }
    else if (stacksLeft) { left = leftStack; vertical = true }
    else {
      below = true
      left = Math.max(EDGE, Math.min(column.right - rowWidth, window.innerWidth - rowWidth - EDGE))
    }

    const clusterTop = below
      ? Math.min(last.bottom + GAP, view.bottom - BTN - EDGE)
      : vertical
        ? Math.max(view.top + MARGIN, Math.min(top, view.bottom - stackHeight - MARGIN))
        : top

    const step = BTN + GAP
    buttons.forEach((button, slot) => {
      button.style.left = `${vertical ? left : left + slot * step}px`
      button.style.top = `${vertical ? clusterTop + slot * step : clusterTop}px`
      button.hidden = false
    })
  }

  return {
    element,
    update,
    hide,
    suppress(value) {
      suppressed = value
      if (value) hide()
    },
  }
}
