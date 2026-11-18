// What the clipboard gets. Selection.toString() and the browser's default
// copy data strip display:none content, and the markers are hidden that
// way, so copy and cut rebuild the markdown from each line's textContent
// instead: what the writer sees is the rendering, what they paste
// elsewhere is the source.
import { blockMarkerLength, blockTrailingMarkerLength } from '../markdown/syntax.js'
import { LINE, kindOf } from './render.js'
import { offsetInLineFor, offsetOfNodeInLine } from './caret.js'

/** The part of one line a selection takes, in source offsets. */
export interface SourceSpan {
  line: HTMLElement
  start: number
  end: number
}

/** What the clipboard gets for a selection: the spans' source, one line each. */
export function reconstructMarkdownFromRange(root: HTMLElement, range: Range): string {
  return selectedSpans(root, range)
    .map(({ line, start, end }) => (end <= start ? '' : (line.textContent || '').slice(start, end)))
    .join('\n')
}

// For each line the range touches, the visible slice of that line's
// textContent, with hidden markers added back ONLY when the selection
// covers the full visible content of the line or of an inline run:
//   - all of "Heading One" selected → `# Heading One`
//   - "ead" inside "Heading One" → just "ead"
//   - the whole "bold" in `**bold**` → `**bold**`
//   - "ol" inside `**bold**` → just "ol"
// Cut removes exactly these spans, so what leaves the document is what
// lands on the clipboard.
export function selectedSpans(root: HTMLElement, range: Range): SourceSpan[] {
  const out: SourceSpan[] = []
  for (const child of Array.from(root.children)) {
    const line = child as HTMLElement
    if (!line.classList.contains(LINE)) continue
    if (!range.intersectsNode(line)) continue

    const kind = kindOf(line)
    const lineText = line.textContent || ''

    // Whole-line markers have no visible content to slice: a range that
    // touches one copies it whole, which is the right round-trip.
    if (kind === 'code-fence-open' || kind === 'code-fence-close'
      || kind === 'rule' || kind === 'table-delim') {
      out.push({ line, start: 0, end: lineText.length })
      continue
    }

    const markerLen = blockMarkerLength(kind, lineText)
    const trailingLen = blockTrailingMarkerLength(kind, lineText)

    let startOffset = 0
    let endOffset = lineText.length
    if (line.contains(range.startContainer) || line === range.startContainer) {
      startOffset = offsetInLineFor(line, range.startContainer, range.startOffset)
    }
    if (line.contains(range.endContainer) || line === range.endContainer) {
      endOffset = offsetInLineFor(line, range.endContainer, range.endOffset)
    }

    // Block-level snap: include the block marker only if the slice covers
    // the line's full visible content. For a table row the visible content
    // stops short of the closing pipe, so a whole-row selection is measured
    // against that — otherwise the copied text would no longer be a table.
    const visibleEnd = lineText.length - trailingLen
    const coversWholeVisible = startOffset <= markerLen && endOffset >= visibleEnd
    let s = coversWholeVisible ? 0 : Math.max(startOffset, markerLen)
    let e = coversWholeVisible ? lineText.length : endOffset

    // Inline snap: a slice that covers a wrapper's full visible inner text
    // expands to include its markers, so selecting the word inside
    // `**bold**` copies the asterisks, and a link's text copies its address.
    // The markers are measured from the DOM because a link's are lopsided.
    for (const wrap of Array.from(line.querySelectorAll('strong, em, code, a'))) {
      const wrapStart = offsetOfNodeInLine(line, wrap)
      if (wrapStart < 0) continue
      const wrapEnd = wrapStart + (wrap.textContent || '').length
      const openLen = (wrap.firstElementChild?.textContent || '').length
      const closeLen = (wrap.lastElementChild?.textContent || '').length
      const innerStart = wrapStart + openLen
      const innerEnd = wrapEnd - closeLen
      if (startOffset <= innerStart && endOffset >= innerEnd) {
        if (wrapStart < s) s = wrapStart
        if (wrapEnd > e) e = wrapEnd
      }
    }

    // A touched line with no visible content selected still contributes an
    // empty entry, so selecting through a line break copies a newline.
    out.push({ line, start: s, end: Math.max(s, e) })
  }
  return out
}
