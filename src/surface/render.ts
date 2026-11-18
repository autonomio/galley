// How the surface draws each of the grammar's kinds. What markdown the
// writer may type is NOT decided here; the grammar lives in
// src/markdown/syntax.ts. This file decides only how the editor draws it.
//
// The surface keeps every character in the DOM and hides markers with CSS,
// because a line's textContent IS the saved file, and because caret
// offsets, annotation anchors and the copy handler all count in source
// characters. So, per kind:
//   - h1…h6 / list-item / quote: leading marker in a hidden span, the
//     rest parsed for inline runs. CSS sizes the line and draws the
//     bullet or the quote bar in the marker's place.
//   - rule: the whole line (`---`) is marker; CSS draws the line.
//   - code fences and a table's delimiter row: the whole line is marker
//     too, but with nothing drawn in its place.
//   - code-content: plain text, no inline parsing — asterisks and
//     backticks inside code are literal.
//   - table-head / table-row: pipes become hidden markers and each cell
//     becomes a `<span class="galley-cell">`. CSS puts the cells on a
//     grid; applyTableLayout gives every row of a table the same tracks.
//
// The line model is flat: the document element's children are lines and
// nothing else, which is why a pipe table is a run of sibling rows sharing
// one grid template rather than a <table>.
import {
  type BlockKind,
  type InlineSegment,
  blockMarkerLength,
  inlineSource,
  parseInline,
  parseTableAligns,
  splitTableRow,
} from '../markdown/syntax.js'
import { tableColumnTemplate } from '../core/tables.js'

export type LineKind = BlockKind

export const LINE = 'galley-line'
export const MARKER = 'galley-marker'
export const CELL = 'galley-cell'

export function isTableRowKind(kind: LineKind): boolean {
  return kind === 'table-head' || kind === 'table-row'
}

// Kinds whose marker is a leading run the writer can delete their way
// out of, demoting the line to prose. The whole-line markers (fences,
// rules, delimiter rows) are deliberately not in this set: there is no
// "rest of the line" left behind to demote to.
export function hasStrippableMarker(kind: LineKind): boolean {
  return kind === 'list-item' || kind === 'quote'
    || (kind.length === 2 && kind[0] === 'h')
}

export function kindOf(line: HTMLElement): LineKind {
  return (line.dataset.kind || 'body') as LineKind
}

function isWholeLineMarker(kind: LineKind): boolean {
  return kind === 'code-fence-open' || kind === 'code-fence-close'
    || kind === 'rule' || kind === 'table-delim'
}

// Every inline run renders as a wrapper holding three children — the
// opening marker, the visible text, the closing marker — with both
// markers in hidden spans. Only the tag and the marker strings differ,
// so the rest of the editor can treat them as one shape.
//
// A link is the same shape with a lopsided closing marker: `[` opens
// it, and `](https://…)` closes it. That is exactly why a link's source
// has to be reachable — see the reveal handling in buildLineEl.
interface InlineWrapSpec { tag: string, open: string, close: string }

function inlineWrapSpec(seg: InlineSegment): InlineWrapSpec | null {
  switch (seg.kind) {
    case 'bold': return { tag: 'STRONG', open: '**', close: '**' }
    case 'italic': return { tag: 'EM', open: seg.marker, close: seg.marker }
    case 'code': return { tag: 'CODE', open: '`', close: '`' }
    case 'link': return { tag: 'A', open: '[', close: `](${seg.url})` }
    default: return null
  }
}

export function isInlineWrap(el: Element | null): boolean {
  const tag = el?.tagName
  return tag === 'STRONG' || tag === 'EM' || tag === 'CODE' || tag === 'A'
}

export function isMarker(node: Node | null | undefined): boolean {
  return !!node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).classList.contains(MARKER)
}

function buildMarkerEl(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = MARKER
  span.textContent = text
  return span
}

function buildInlineWrap(spec: InlineWrapSpec, inner: string): HTMLElement {
  const wrap = document.createElement(spec.tag)
  wrap.appendChild(buildMarkerEl(spec.open))
  wrap.appendChild(document.createTextNode(inner))
  wrap.appendChild(buildMarkerEl(spec.close))
  return wrap
}

// Does this line hold a link? Used to decide whether moving the caret
// onto or off it needs a rebuild, so it has to be cheap enough to run
// on every cursor move — hence a regex over the source rather than a
// parse.
export const LINK_HINT_RE = /\[[^\]\n]+\]\(/

// Fill a container with the inline-parsed form of `text`.
//
// `revealLinks` renders a link as its own source instead of as a hidden
// URL. A link is the one run whose marker is arbitrarily long, so a
// caret that cannot reach it means a mistyped URL can only be fixed by
// deleting the whole link and starting again. The editor therefore
// shows the source of any link on the line the caret is on, and hides
// it again the moment the caret leaves — the same bargain the table
// delimiter row strikes. Bold, italic and code keep their markers
// hidden throughout: those are one or two characters sitting right
// against their text, and backspacing through them already works.
//
// An empty container still gets an empty text node: without one there
// is no anchor for the caret to land on, and a fresh table row is
// nothing but empty cells. The trailing sentinel after a wrapped run is
// the same device, for the same reason — typing after a bold run must
// not extend it.
function fillInline(el: HTMLElement, text: string, revealLinks: boolean): void {
  if (text === '') {
    el.appendChild(document.createTextNode(''))
    return
  }
  const segs = parseInline(text)
  let lastWasWrap = false
  for (const seg of segs) {
    const spec = revealLinks && seg.kind === 'link' ? null : inlineWrapSpec(seg)
    if (spec) {
      el.appendChild(buildInlineWrap(spec, seg.text))
      lastWasWrap = true
    } else {
      el.appendChild(document.createTextNode(inlineSource(seg)))
      lastWasWrap = false
    }
  }
  if (lastWasWrap) el.appendChild(document.createTextNode(''))
}

// For list-item lines, the visual marker the ::before pseudo-element
// shows. Bullet lines (`- `) render as a designed `•` glyph; numbered
// lines keep the writer's delimiter choice (`1.` vs `1)`).
function listMarkerFor(prefix: string): string {
  return prefix.startsWith('-') ? '•' : prefix.trimEnd()
}

// Build a fresh line element. Every marker character stays in
// textContent — hidden, but present — so save, copy and the caret all
// still see real markdown. `revealLinks` is set for the line the caret
// is on; see fillInline.
export function buildLineEl(text: string, kind: LineKind, revealLinks: boolean = false): HTMLDivElement {
  const div = document.createElement('div')
  div.className = LINE
  div.dataset.kind = kind

  // Kinds whose entire line is marker. A fence, a rule and a table's
  // delimiter row have no content of their own to show: CSS draws
  // whatever stands in their place, or nothing at all.
  if (isWholeLineMarker(kind)) {
    if (text === '') div.appendChild(document.createElement('br'))
    else div.appendChild(buildMarkerEl(text))
    return div
  }

  // Kinds shown as their own source: code, and the delimiter row the
  // caret is currently on.
  if (kind === 'code-content' || kind === 'source') {
    if (text === '') div.appendChild(document.createElement('br'))
    else div.appendChild(document.createTextNode(text))
    return div
  }

  if (isTableRowKind(kind)) {
    const parts = splitTableRow(text)
    // classifyLines only hands out row kinds to text that splits, so the
    // fallback is unreachable in practice; keeping it means a line that
    // somehow arrives malformed renders as its own source rather than as
    // an empty row the writer cannot recover.
    if (!parts) {
      if (text === '') div.appendChild(document.createElement('br'))
      else div.appendChild(document.createTextNode(text))
      return div
    }
    parts.markers.forEach((marker, i) => {
      div.appendChild(buildMarkerEl(marker))
      if (i < parts.cells.length) {
        const cell = document.createElement('span')
        cell.className = CELL
        fillInline(cell, parts.cells[i], revealLinks)
        div.appendChild(cell)
      }
    })
    if (revealLinks && LINK_HINT_RE.test(text)) div.dataset.reveal = 'links'
    return div
  }

  const prefix = text.slice(0, blockMarkerLength(kind, text))
  const rest = text.slice(prefix.length)
  if (prefix) div.appendChild(buildMarkerEl(prefix))
  if (kind === 'list-item') div.dataset.listMarker = listMarkerFor(prefix)
  if (rest === '') {
    div.appendChild(document.createElement('br'))
    return div
  }
  fillInline(div, rest, revealLinks)
  if (revealLinks && LINK_HINT_RE.test(rest)) div.dataset.reveal = 'links'
  return div
}

// ── Does the DOM still match the model? ──────────────────────────────
//
// Used to decide whether to rebuild a line on input. Mismatch happens when
// the kind changed (a marker was typed or erased, or a fence appeared up
// the document), a marker span drifted from its kind's prefix, the inline
// structure changed (a `**` pair closed or broke), or a segment got split
// across text nodes by a browser edit (caret accounting depends on each
// segment being a single text node). `kind` is supplied by the caller
// because code-block kinds depend on cross-line state.

// Does one DOM node match what fillInline would have built for one
// parsed segment? A plain run is a single text node; every wrapped run
// is its tag holding marker / text / marker. A link on a revealed line
// is rendered as its own source, so it matches a plain text node too.
function inlineSegMatches(node: Node | undefined, seg: InlineSegment, revealLinks: boolean): boolean {
  if (!node) return false
  const spec = revealLinks && seg.kind === 'link' ? null : inlineWrapSpec(seg)
  if (!spec) {
    return node.nodeType === Node.TEXT_NODE && node.textContent === inlineSource(seg)
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as HTMLElement
  if (el.tagName !== spec.tag) return false
  if (el.childNodes.length !== 3) return false
  const [open, inner, close] = Array.from(el.childNodes)
  if (!isMarker(open) || open.textContent !== spec.open) return false
  if (!isMarker(close) || close.textContent !== spec.close) return false
  return inner.nodeType === Node.TEXT_NODE && inner.textContent === seg.text
}

// Whether fillInline would have closed this run of segments with the
// empty-text sentinel it appends after a wrapped run.
function endsInWrap(segs: InlineSegment[], revealLinks: boolean): boolean {
  const last = segs[segs.length - 1]
  if (!last) return false
  return !!(revealLinks && last.kind === 'link' ? null : inlineWrapSpec(last))
}

// Validates a run of nodes filled by fillInline — a table cell's
// children, or what follows an ordinary line's block marker.
function inlineMatchesModel(children: Node[], text: string, revealLinks: boolean): boolean {
  if (text === '') {
    return children.length === 1
      && children[0].nodeType === Node.TEXT_NODE
      && children[0].textContent === ''
  }
  const segs = parseInline(text)
  const sentinel = endsInWrap(segs, revealLinks)
  if (children.length !== segs.length && !(sentinel && children.length === segs.length + 1)) return false
  for (let i = 0; i < segs.length; i++) {
    if (!inlineSegMatches(children[i], segs[i], revealLinks)) return false
  }
  if (children.length > segs.length) {
    const tail = children[segs.length]
    if (tail.nodeType !== Node.TEXT_NODE || tail.textContent !== '') return false
  }
  return true
}

function isOnlyBr(children: Node[]): boolean {
  return children.length === 1
    && children[0].nodeType === Node.ELEMENT_NODE
    && (children[0] as HTMLElement).tagName === 'BR'
}

export function lineMatchesModel(line: HTMLElement, kind: LineKind, revealLinks: boolean): boolean {
  if (line.dataset.kind !== kind) return false
  const txt = line.textContent || ''
  const children = Array.from(line.childNodes)

  // The caret arriving on or leaving a line that holds a link changes
  // how that link is drawn, so it has to force a rebuild.
  const wantReveal = revealLinks && LINK_HINT_RE.test(txt)
  if ((line.dataset.reveal === 'links') !== wantReveal) return false

  // If the writer edited a list number ("1." → "2."), the cached marker
  // attribute would stay stale unless we force a rebuild.
  if (kind === 'list-item') {
    const prefix = txt.slice(0, blockMarkerLength(kind, txt))
    if (line.dataset.listMarker !== listMarkerFor(prefix)) return false
  }

  if (isWholeLineMarker(kind)) {
    if (txt === '') return isOnlyBr(children)
    return children.length === 1 && isMarker(children[0]) && children[0].textContent === txt
  }

  if (kind === 'code-content' || kind === 'source') {
    if (txt === '') return isOnlyBr(children)
    return children.length === 1
      && children[0].nodeType === Node.TEXT_NODE
      && children[0].textContent === txt
  }

  if (isTableRowKind(kind)) {
    const parts = splitTableRow(txt)
    if (!parts) {
      // Mirrors buildLineEl's unreachable fallback: one plain text node.
      return children.length === 1
        && children[0].nodeType === Node.TEXT_NODE
        && children[0].textContent === txt
    }
    if (children.length !== parts.markers.length + parts.cells.length) return false
    for (let m = 0; m < parts.markers.length; m++) {
      const marker = children[m * 2]
      if (!isMarker(marker) || marker.textContent !== parts.markers[m]) return false
      if (m >= parts.cells.length) continue
      const cell = children[m * 2 + 1]
      if (cell.nodeType !== Node.ELEMENT_NODE || !(cell as HTMLElement).classList.contains(CELL)) return false
      if (!inlineMatchesModel(Array.from(cell.childNodes), parts.cells[m], revealLinks)) return false
    }
    return true
  }

  const prefixLen = blockMarkerLength(kind, txt)
  const expectedPrefix = txt.slice(0, prefixLen)
  const rest = txt.slice(prefixLen)
  let i = 0

  if (expectedPrefix !== '') {
    const first = children[i]
    if (!isMarker(first) || first.textContent !== expectedPrefix) return false
    i++
  }

  if (rest === '') {
    // Empty rest: exactly one <br> filler.
    if (children.length !== i + 1) return false
    const br = children[i]
    return br.nodeType === Node.ELEMENT_NODE && (br as HTMLElement).tagName === 'BR'
  }

  // Everything after the block marker is one inline run, validated the
  // same way a table cell's is.
  return inlineMatchesModel(children.slice(i), rest, revealLinks)
}

/**
 * Give `line` the children and attributes buildLineEl would give `text` at
 * `kind`. The line element itself stays, so references to it stay valid.
 */
export function adoptLine(line: HTMLElement, fresh: HTMLElement): void {
  if (fresh.dataset.reveal !== undefined) line.dataset.reveal = fresh.dataset.reveal
  else delete line.dataset.reveal
  line.dataset.kind = fresh.dataset.kind!
  // When a line leaves list-item, delete the stale attribute so CSS doesn't
  // render a ghost bullet.
  if (fresh.dataset.listMarker !== undefined) line.dataset.listMarker = fresh.dataset.listMarker
  else delete line.dataset.listMarker
  line.innerHTML = ''
  while (fresh.firstChild) line.appendChild(fresh.firstChild)
}

// ── Tables ───────────────────────────────────────────────────────────

function clearTableLayout(line: HTMLElement): void {
  if (line.style.gridTemplateColumns) line.style.gridTemplateColumns = ''
}

// Hand every row of a table the same grid tracks, and each cell its
// column's alignment. This is a separate pass from the rebuild because it
// depends on the whole block rather than on one line, and because column
// widths change far more often than DOM structure does.
export function applyTableLayout(root: HTMLElement): void {
  const lines = Array.from(root.children) as HTMLElement[]
  let i = 0
  while (i < lines.length) {
    if (lines[i].dataset.kind !== 'table-head') {
      clearTableLayout(lines[i])
      i++
      continue
    }
    const rows: HTMLElement[] = [lines[i]]
    let delimText = ''
    let j = i + 1
    const delimKind = lines[j]?.dataset.kind
    if (delimKind === 'table-delim' || delimKind === 'source') {
      delimText = lines[j].textContent || ''
      clearTableLayout(lines[j])
      j++
    }
    while (lines[j]?.dataset.kind === 'table-row') { rows.push(lines[j]); j++ }

    const template = tableColumnTemplate(rows.map((row) => row.textContent || ''))
    const aligns = parseTableAligns(delimText)
    for (const row of rows) {
      if (row.style.gridTemplateColumns !== template) row.style.gridTemplateColumns = template
      row.querySelectorAll<HTMLElement>(`:scope > .${CELL}`).forEach((cell, c) => {
        const want = aligns[c] ?? ''
        if (cell.style.textAlign !== want) cell.style.textAlign = want
      })
    }
    i = j
  }
}
