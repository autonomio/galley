// Caret and offset helpers. Everything here works in textContent character
// coordinates — hidden marker characters included — so a position survives
// a line being rebuilt with a different kind: offset 2 in `# Hello` is just
// after the marker, which is offset 0 of the visible "Hello".
import { LINE, isInlineWrap, isMarker, isTableRowKind, kindOf } from './render.js'

/** Nearest line element at or above `node`, or null outside any line. */
export function lineElOf(node: Node | null): HTMLElement | null {
  let n: Node | null = node
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList?.contains(LINE)) return n as HTMLElement
    n = n.parentNode
  }
  return null
}

export function getCursorOffsetInLine(line: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null
  if (!line.contains(sel.anchorNode)) return null
  let offset = 0
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node === sel.anchorNode) return offset + sel.anchorOffset
    offset += (node.textContent || '').length
  }
  // Anchor was inside line but not in a text node (e.g. before a <br>).
  return offset
}

function placeCaret(target: Node, at: number): void {
  const sel = window.getSelection()
  const r = document.createRange()
  r.setStart(target, at)
  r.collapse(true)
  if (sel) { sel.removeAllRanges(); sel.addRange(r) }
}

export function setCursorOffsetInLine(line: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let acc = 0
  let node: Node | null
  let prev: Node | null = null
  while ((node = walker.nextNode())) {
    const len = (node.textContent || '').length
    if (acc + len >= offset) {
      const localOffset = offset - acc

      // Table rows hide a pipe marker between every pair of cells, so
      // the offset that starts a cell is also the offset that ends the
      // marker before it — and this walk, taking the first node that
      // reaches the offset, lands in the marker. That is a text node
      // the caret cannot be seen in and typing there would grow the
      // pipe rather than the cell, so step to the neighbouring cell's
      // own text instead: forward normally, back for the closing pipe
      // at end-of-row, which has no cell after it. Scoped to table
      // lines on purpose — heading and list markers sit at the very
      // start of a line, and the inline-wrapper case below wants the
      // sentinel rather than the next node.
      if (localOffset === len && isTableRowKind(kindOf(line)) && isMarker(node.parentNode)) {
        const next = walker.nextNode()
        if (next) { placeCaret(next, 0); return }
        if (prev) { placeCaret(prev, (prev.textContent || '').length); return }
      }

      // Edge: when the cursor is exactly at the end of the trailing
      // marker of a <strong>/<code>, placing it inside that marker
      // means the next keystroke extends the wrapper. We want the
      // opposite: typing after a bold or code run should produce plain
      // text. Prefer the trailing empty-text sentinel buildLineEl
      // appends after a wrapped-ending line — a real text-node anchor
      // outside the wrapper. Failing that, place at line level after
      // the wrapper; the sentinel is re-added on the next reclassify.
      if (localOffset === len && node.parentNode && isMarker(node.parentNode)) {
        const markerSpan = node.parentNode as HTMLElement
        const wrap = markerSpan.parentNode as HTMLElement | null
        if (wrap && isInlineWrap(wrap) && markerSpan === wrap.lastElementChild) {
          const sentinel = wrap.nextSibling
          if (sentinel && sentinel.nodeType === Node.TEXT_NODE) { placeCaret(sentinel, 0); return }
          const lineLevel = wrap.parentNode!
          placeCaret(lineLevel, Array.from(lineLevel.childNodes).indexOf(wrap) + 1)
          return
        }
      }

      placeCaret(node, localOffset)
      return
    }
    acc += len
    prev = node
  }
  // Fallback: place caret at end of line.
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(line)
  range.collapse(false)
  if (sel) { sel.removeAllRanges(); sel.addRange(range) }
}

// Convert a (container, offset) anchor inside a line to a single
// character offset within that line's textContent (which counts hidden
// marker chars).
//   - text-node container: char-offset in that text node + sum of
//     text lengths that come earlier in the line subtree.
//   - element container: offset is a child index; sum lengths of
//     children before that index, recursively.
export function offsetInLineFor(line: HTMLElement, container: Node, offset: number): number {
  let acc = 0
  let found = false
  function visit(node: Node): void {
    if (found) return
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) {
        acc += offset
      } else {
        const kids = node.childNodes
        for (let i = 0; i < offset && i < kids.length; i++) acc += (kids[i].textContent || '').length
      }
      found = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      acc += (node.textContent || '').length
      return
    }
    for (const c of Array.from(node.childNodes)) visit(c)
  }
  visit(line)
  return acc
}

// The textContent offset where a descendant node's content starts within
// the line, or -1 when it is not in the line.
export function offsetOfNodeInLine(line: HTMLElement, node: Node): number {
  let acc = 0
  let found = false
  function visit(n: Node): void {
    if (found) return
    if (n === node) { found = true; return }
    if (n.nodeType === Node.TEXT_NODE) acc += (n.textContent || '').length
    else if (n.nodeType === Node.ELEMENT_NODE) for (const c of Array.from(n.childNodes)) visit(c)
  }
  visit(line)
  return found ? acc : -1
}

// The (text-node, offset) pair for a char offset within line.textContent.
// Past the end it pins to the end of the last text node, so a Range can
// still be built for end-of-line cases.
export function textNodeAtOffset(line: HTMLElement, offset: number): { node: Node, offset: number } | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let acc = 0
  let last: Node | null = null
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = (node.textContent || '').length
    if (acc + len >= offset) return { node, offset: offset - acc }
    acc += len
    last = node
  }
  if (last) return { node: last, offset: (last.textContent || '').length }
  return null
}

// Walk up from a node looking for an inline wrapper inside `root`.
export function inlineWrapAncestorOf(root: HTMLElement, node: Node | null): HTMLElement | null {
  let n: Node | null = node
  while (n) {
    if (n === root) return null
    if (n.nodeType === Node.ELEMENT_NODE && isInlineWrap(n as Element)) return n as HTMLElement
    n = n.parentNode
  }
  return null
}

// Cmd+B is bold-only: toggle off only when the wrapper is <strong>.
export function strongAncestorOf(root: HTMLElement, node: Node | null): HTMLElement | null {
  const wrap = inlineWrapAncestorOf(root, node)
  return wrap && wrap.tagName === 'STRONG' ? wrap : null
}

// Detect a caret position whose next typed character will, by default,
// land inside the trailing marker of a <strong>/<code> and visually
// extend the wrapper. Three equivalent positions trigger this:
//   1. Caret at the end of the trailing marker's text node.
//   2. Caret at line level immediately after a <strong>/<code> with
//      no following text node.
//   3. Caret in the empty post-wrapper sentinel. It is a real text-node
//      anchor, but Chrome still routes typed characters into the previous
//      element when the sentinel is empty.
// In all three cases the insertion is redirected to a sibling text node
// after the wrapper, so typing produces plain text.
export function inlineWrapAtCaretEdge(range: Range): HTMLElement | null {
  const node = range.startContainer
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentNode as HTMLElement | null
    if (!parent) return null
    if (isMarker(parent)) {
      const wrap = parent.parentNode as HTMLElement | null
      if (!wrap || (wrap.tagName !== 'STRONG' && wrap.tagName !== 'CODE')) return null
      if (parent !== wrap.lastElementChild) return null
      if (range.startOffset !== (node.textContent || '').length) return null
      return wrap
    }
    if (node.textContent === '' && parent.classList.contains(LINE)
        && node.previousSibling
        && node.previousSibling.nodeType === Node.ELEMENT_NODE) {
      const prev = node.previousSibling as HTMLElement
      if (isInlineWrap(prev)) return prev
    }
    return null
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement
    if (!el.classList.contains(LINE)) return null
    const prev = el.childNodes[range.startOffset - 1]
    if (!prev || prev.nodeType !== Node.ELEMENT_NODE) return null
    const tag = (prev as HTMLElement).tagName
    if (tag !== 'STRONG' && tag !== 'CODE') return null
    return prev as HTMLElement
  }
  return null
}

// Where a pointer event lands, in document terms. caretRangeFromPoint is the
// widely supported spelling; caretPositionFromPoint is the standard one.
export function caretRangeFromPoint(x: number, y: number): Range | null {
  const d = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node, offset: number } | null
  }
  if (typeof d.caretRangeFromPoint === 'function') return d.caretRangeFromPoint(x, y)
  const pos = d.caretPositionFromPoint?.(x, y)
  if (!pos) return null
  const r = document.createRange()
  r.setStart(pos.offsetNode, pos.offset)
  r.collapse(true)
  return r
}

// Place the caret at the end of the document, inside text rather than
// after a <br> filler (which produces a "phantom row" caret).
export function placeCaretAtEnd(root: HTMLElement): void {
  const last = root.lastElementChild as HTMLElement | null
  if (!last) return
  const range = document.createRange()
  let target: Node = last
  while (target.lastChild && target.lastChild.nodeType !== Node.TEXT_NODE && target.lastChild.nodeName !== 'BR') {
    target = target.lastChild
  }
  if (target.lastChild && target.lastChild.nodeType === Node.TEXT_NODE) {
    target = target.lastChild
    range.setStart(target, (target.textContent || '').length)
  } else {
    range.selectNodeContents(target)
    range.collapse(false)
  }
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

/** Whether the live selection sits inside `root`. */
export function selectionIn(root: HTMLElement): Range | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== root) return null
  return range
}
