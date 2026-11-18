// The writing surface: one contenteditable element whose children are
// per-line <div class="galley-line" data-kind=…> blocks. Markdown is drawn
// as you type and every marker character stays in the DOM, hidden, so the
// line's textContent is always the saved source.
//
// The surface knows nothing about documents, storage or chrome. It takes
// text in (setText), hands text out (getText), owns the caret, the undo
// history and every editing gesture, and reports each edit through
// onChange. Everything else in Galley is built around it, and a host can
// use it on its own.
import {
  blockMarkerLength,
  blockTrailingMarkerLength,
  classifyLines,
  emptyTableRowText,
  isTableDelimText,
  isTableRowText,
  isWhollyHidden,
  splitTableRow,
  tableDelimTextFor,
} from '../markdown/syntax.js'
import { tableCellSpans } from '../core/tables.js'
import { HISTORY_BYTE_BUDGET, HISTORY_LIMIT, trimHistoryStacks, type HistoryEntry } from '../core/history.js'
import { snapshotOf, locateLine, type TextSnapshot } from '../core/text.js'
import {
  CELL,
  LINE,
  LINK_HINT_RE,
  adoptLine,
  applyTableLayout,
  buildLineEl,
  hasStrippableMarker,
  isInlineWrap,
  isMarker,
  isTableRowKind,
  kindOf,
  lineMatchesModel,
} from './render.js'
import {
  caretRangeFromPoint,
  getCursorOffsetInLine,
  inlineWrapAtCaretEdge,
  lineElOf,
  offsetInLineFor,
  placeCaretAtEnd,
  selectionIn,
  setCursorOffsetInLine,
  strongAncestorOf,
  textNodeAtOffset,
} from './caret.js'
import { reconstructMarkdownFromRange, selectedSpans } from './clipboard.js'
import {
  caretAtCellEdge,
  lastTableLineOf,
  nextTableRowLine,
  placeCaretInTableCell,
  prevTableRowLine,
} from './tables.js'

export type SurfaceCommand = 'save' | 'new'

export interface SurfaceOptions {
  /** After every edit the writer makes, once the DOM is canonical again. */
  onChange?(): void
  /** After the selection moved; `focused` is whether the surface has focus. */
  onSelectionChange?(focused: boolean): void
  /** A shortcut the surface does not handle itself: ⌘S, ⌘N. */
  onCommand?(command: SurfaceCommand, event: KeyboardEvent): void
  /** Something the writer should know that is not an error (undo steps dropped). */
  onNotice?(message: string): void
  /** Accessible name of the writing area. */
  label?: string
}

export interface HistoryState {
  current: HistoryEntry
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

export interface SurfaceHistory {
  /** Forget every step; the next edit starts a new timeline. */
  reset(): void
  /** Close the current step and snapshot now, before a direct mutation. */
  record(): void
  undo(): void
  redo(): void
  export(): HistoryState
  import(state: { undo: HistoryEntry[], redo: HistoryEntry[] }): void
}

export interface Surface {
  readonly element: HTMLElement
  readonly history: SurfaceHistory
  /** The document's markdown, exactly as it would be saved. */
  getText(): string
  /** Replace the document. Not an edit: no change is reported, history is kept. */
  setText(text: string): void
  lines(): HTMLElement[]
  snapshot(): TextSnapshot
  /** A DOM Range over [start, end) in snapshot coordinates. */
  domRange(start: number, end: number, snap?: TextSnapshot): Range | null
  /** The caret as (line index, offset into that line's source). */
  caret(): { line: number, offset: number } | null
  setCaret(line: number, offset: number): void
  placeCaretAtEnd(): void
  focus(): void
  isEmpty(): boolean
  isFocused(): boolean
  /** Whether the writer can type. */
  setEditable(editable: boolean): void
  /** Frozen: every edit and undo is refused while something else owns the text. */
  setFrozen(frozen: boolean): void
  readonly frozen: boolean
  destroy(): void
}

const HISTORY_COALESCE_MS = 450

interface DragSource {
  startLine: HTMLElement
  endLine: HTMLElement
  startOffset: number
  endOffset: number
}

type BoundaryDelete = false | 'moved' | 'edited'

// Wrap `s` in `**…**`, keeping any whitespace at its edges OUTSIDE the
// markers. CommonMark's flanking rules say a `**` run preceded by
// whitespace can't close and one followed by whitespace can't open, so
// `**bold **text` is not emphasis at all. Selections routinely carry a
// trailing space (that's what a double-click hands us), so normalise here.
// Whitespace-only input is returned untouched — there's nothing to bold.
export function wrapBoldPreservingEdgeSpace(s: string): string {
  const lead = /^\s*/.exec(s)![0]
  const trail = /\s*$/.exec(s.slice(lead.length))![0]
  const core = s.slice(lead.length, s.length - trail.length)
  return core ? `${lead}**${core}**${trail}` : s
}

export function createSurface(docEl: HTMLElement, options: SurfaceOptions = {}): Surface {
  docEl.classList.add('galley-doc')
  docEl.contentEditable = 'false'
  docEl.spellcheck = true
  docEl.setAttribute('role', 'textbox')
  docEl.setAttribute('aria-multiline', 'true')
  docEl.setAttribute('aria-label', options.label ?? 'Document')

  let frozen = false
  const cleanups: (() => void)[] = []
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void, capture = false,
  ) => {
    target.addEventListener(type, handler as EventListener, capture)
    cleanups.push(() => target.removeEventListener(type, handler as EventListener, capture))
  }

  // Every edit funnels through here once the DOM is canonical.
  function changed(): void {
    updateEmptyState()
    options.onChange?.()
  }

  // ── Load / serialize ──────────────────────────────────────────────

  // One line div per `\n`-split row. serializeDoc(load(x)) is exactly x.
  function loadIntoEditor(content: string): void {
    docEl.innerHTML = ''
    const lines = content === '' ? [''] : content.split('\n')
    const kinds = classifyLines(lines)
    for (let i = 0; i < lines.length; i++) docEl.appendChild(buildLineEl(lines[i], kinds[i]))
    applyTableLayout(docEl)
    updateEmptyState()
  }

  // textContent transparently strips the <br> filler from empty lines,
  // so empty rows serialize back to '' and rejoin into the right string.
  function serializeDoc(): string {
    const lines: string[] = []
    for (const child of Array.from(docEl.children)) lines.push((child as HTMLElement).textContent || '')
    return lines.join('\n')
  }

  function lineTexts(): string[] {
    return Array.from(docEl.children).map((child) => child.textContent || '')
  }

  function updateEmptyState(): void {
    if (serializeDoc() === '') docEl.dataset.empty = 'true'
    else docEl.removeAttribute('data-empty')
  }

  // ── Undo / redo ───────────────────────────────────────────────────
  //
  // The browser's own undo stack can't be used here. reclassifyLines
  // rewrites a line's children outside any editing transaction, so every
  // marker transition — `# `, `## `, `- `, `1. `, ``` — detaches the nodes
  // Chrome's undo records point at, and those records become no-ops or
  // jump to unrelated lines.
  //
  // So the surface keeps its own history of whole-document markdown
  // snapshots plus a caret position, and owns ⌘Z / ⌘⇧Z outright.
  // Documents are capped at 5 MiB and typically a few KB, so full
  // snapshots are far cheaper than tracking deltas correctly. Both stacks
  // are bounded by HISTORY_BYTE_BUDGET; oldest steps go first, and the
  // first reduction is reported so it stays visible.
  let historyUndo: HistoryEntry[] = []
  let historyRedo: HistoryEntry[] = []
  let historyPre: HistoryEntry | null = null
  let historyBatchOpen = false
  let historyBatchTimer: ReturnType<typeof setTimeout> | null = null
  // Set while the document is rebuilt from a snapshot, so the resulting
  // DOM churn doesn't record history of its own.
  let historySuppress = false
  let historyTrimNoticed = false

  // The byte budget binds the live stacks too: 300 whole-document
  // snapshots of a 5 MiB document would otherwise hold 1.5 GiB.
  function trimHistoryMemory(): void {
    const dropped = trimHistoryStacks(historyUndo, historyRedo, HISTORY_BYTE_BUDGET)
    if (dropped > 0 && !historyTrimNoticed) {
      historyTrimNoticed = true
      console.warn(`[galley] history dropped ${dropped} steps to stay within its byte budget`)
      options.onNotice?.('Older undo steps were dropped to stay within the undo history budget')
    }
  }

  function caretSourcePosition(): { line: number, offset: number } | null {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    const line = lineElOf(range.startContainer)
    if (!line || line.parentElement !== docEl) return null
    const idx = Array.prototype.indexOf.call(docEl.children, line)
    if (idx < 0) return null
    return { line: idx, offset: offsetInLineFor(line, range.startContainer, range.startOffset) }
  }

  function captureHistoryEntry(): HistoryEntry {
    const pos = caretSourcePosition()
    return { text: serializeDoc(), line: pos?.line ?? 0, offset: pos?.offset ?? 0 }
  }

  function closeHistoryBatch(): void {
    historyBatchOpen = false
    historyPre = null
    if (historyBatchTimer !== null) { clearTimeout(historyBatchTimer); historyBatchTimer = null }
  }

  function resetHistory(): void {
    historyUndo = []
    historyRedo = []
    historyTrimNoticed = false
    closeHistoryBatch()
  }

  // Called from beforeinput — snapshots the document as it stands *before*
  // the edit lands, so one undo restores it. Cheap when a batch is already
  // open (the common case while typing a word).
  function noteHistoryPre(): void {
    if (historySuppress || historyBatchOpen) return
    historyPre = captureHistoryEntry()
  }

  // Called once the edit has landed. `immediate` closes the undo step now
  // (structural edit); otherwise typing keeps coalescing into it.
  function commitHistoryBatch(immediate: boolean): void {
    if (historySuppress) return
    if (!historyBatchOpen) {
      if (historyPre) {
        historyUndo.push(historyPre)
        if (historyUndo.length > HISTORY_LIMIT) historyUndo.shift()
        historyRedo = []
        trimHistoryMemory()
      }
      historyBatchOpen = true
    }
    if (historyBatchTimer !== null) { clearTimeout(historyBatchTimer); historyBatchTimer = null }
    if (immediate) { closeHistoryBatch(); return }
    historyBatchTimer = setTimeout(closeHistoryBatch, HISTORY_COALESCE_MS)
  }

  // For mutations made directly, without going through beforeinput /
  // input (bold run-splitting, table gestures, an applied edit).
  // Snapshot first, then mutate.
  function recordHistoryPoint(): void {
    if (historySuppress) return
    closeHistoryBatch()
    historyUndo.push(captureHistoryEntry())
    if (historyUndo.length > HISTORY_LIMIT) historyUndo.shift()
    historyRedo = []
    trimHistoryMemory()
  }

  function restoreHistoryEntry(entry: HistoryEntry): void {
    historySuppress = true
    try {
      loadIntoEditor(entry.text)
      const idx = Math.max(0, Math.min(entry.line, docEl.children.length - 1))
      const line = docEl.children[idx] as HTMLElement | undefined
      if (line) {
        docEl.focus()
        setCursorOffsetInLine(line, Math.max(0, Math.min(entry.offset, (line.textContent || '').length)))
      }
      changed()
    } finally {
      historySuppress = false
    }
  }

  function undo(): void {
    if (frozen) return
    closeHistoryBatch()
    const prev = historyUndo.pop()
    if (!prev) return
    historyRedo.push(captureHistoryEntry())
    if (historyRedo.length > HISTORY_LIMIT) historyRedo.shift()
    trimHistoryMemory()
    restoreHistoryEntry(prev)
  }

  function redo(): void {
    if (frozen) return
    closeHistoryBatch()
    const next = historyRedo.pop()
    if (!next) return
    historyUndo.push(captureHistoryEntry())
    if (historyUndo.length > HISTORY_LIMIT) historyUndo.shift()
    trimHistoryMemory()
    restoreHistoryEntry(next)
  }

  // ── Source-preserving structural edits ────────────────────────────
  //
  // Chrome's native line merge is unusable here. When it joins two lines
  // it moves only *rendered* content: the display:none marker spans are
  // discarded, so a single Backspace at a line start silently rewrote
  // `second with **bold** text` as `second with bold text`.
  //
  // So every edit that spans a line boundary is performed here instead,
  // in markdown-source coordinates (each line's textContent, markers
  // included), and the DOM is rebuilt from that. Callers preventDefault
  // the native behaviour first.

  // Replace the source span between (startLine, startOff) and
  // (endLine, endOff) with `insert`, then re-derive the whole line tree.
  // `insert` may contain newlines — a paste over a multi-line selection
  // goes through here too.
  function replaceSourceRange(
    startLine: HTMLElement, startOff: number,
    endLine: HTMLElement, endOff: number,
    insert: string,
  ): void {
    const head = (startLine.textContent || '').slice(0, startOff)
    const tail = (endLine.textContent || '').slice(endOff)

    // Drop every line from startLine's successor through endLine; their
    // content is already folded into head/tail.
    if (startLine !== endLine) {
      let n = startLine.nextElementSibling
      while (n) {
        const next = n.nextElementSibling
        const wasEnd = n === endLine
        n.remove()
        if (wasEnd) break
        n = next
      }
    }

    const merged = head + insert + tail
    const caretOffset = head.length + insert.length
    const parts = merged.split('\n')
    // Build as `body` placeholders and let reclassifyLines assign real
    // kinds — it has the cross-line context (code fences) a local
    // decision here would miss.
    const built: HTMLElement[] = []
    const frag = document.createDocumentFragment()
    for (const part of parts) {
      const el = buildLineEl(part, 'body')
      built.push(el)
      frag.appendChild(el)
    }
    startLine.replaceWith(frag)
    reclassifyLines()

    // Walk the caret's source offset back into (line, offset). Rebuilds
    // mutate line elements in place, so `built` references stay valid.
    let remaining = caretOffset
    let idx = 0
    while (idx < parts.length - 1 && remaining > parts[idx].length) {
      remaining -= parts[idx].length + 1
      idx++
    }
    const target = built[idx]
    if (target) setCursorOffsetInLine(target, Math.max(0, Math.min(remaining, (target.textContent || '').length)))
  }

  // Join `line` onto the line above it. The surviving line keeps its own
  // block marker; the incoming line's marker is dropped, since a single
  // line can only carry one. Inline markers ride along untouched because
  // source text moves, not rendered nodes.
  function mergeLineBackward(line: HTMLElement): void {
    const keep = line.previousElementSibling as HTMLElement | null
    if (!keep) return
    const kind = kindOf(line)
    const text = line.textContent || ''
    const dropLen = hasStrippableMarker(kind) ? blockMarkerLength(kind, text) : 0
    replaceSourceRange(keep, (keep.textContent || '').length, line, dropLen, '')
  }

  // Remove a line's block marker in place, demoting it to body text.
  // The caret snaps past a hidden marker, so Backspace at the visible
  // start of a heading or list item had nothing behind it to delete.
  // Now it strips the marker, and a second Backspace merges the line.
  function stripBlockMarker(line: HTMLElement): void {
    const kind = kindOf(line)
    const len = blockMarkerLength(kind, line.textContent || '')
    if (len <= 0) return
    replaceSourceRange(line, 0, line, len, '')
  }

  // Rebuild one line, keeping the selection. A collapsed caret goes back
  // through setCursorOffsetInLine and its marker rules; a selection with an
  // end in this line keeps both ends, so a word selected just as its line is
  // redrawn (the caret's arrival reveals a link) stays selected.
  function rebuildLineInPlace(line: HTMLElement, kind: ReturnType<typeof kindOf>, revealLinks = false): void {
    const txt = line.textContent || ''
    type End = { inLine: number } | { node: Node, offset: number }
    const sel = window.getSelection()
    const ranged = !!sel && sel.rangeCount > 0 && !sel.isCollapsed
    const end = (node: Node | null, offset: number): End | null => node && line.contains(node)
      ? { inLine: offsetInLineFor(line, node, offset) }
      : node ? { node, offset } : null
    const anchor = ranged ? end(sel!.anchorNode, sel!.anchorOffset) : null
    const focus = ranged ? end(sel!.focusNode, sel!.focusOffset) : null
    const cursor = ranged ? null : getCursorOffsetInLine(line)
    adoptLine(line, buildLineEl(txt, kind, revealLinks))
    if (cursor !== null) { setCursorOffsetInLine(line, cursor); return }
    if (!anchor || !focus || (!('inLine' in anchor) && !('inLine' in focus))) return
    const place = (e: End) => ('inLine' in e ? textNodeAtOffset(line, e.inLine) : e)
    const a = place(anchor)
    const f = place(focus)
    if (a && f) {
      try { sel!.setBaseAndExtent(a.node, a.offset, f.node, f.offset) } catch { /* leave the selection */ }
    }
  }

  // Renumber the ordered-list block containing `line`. Inserting into a
  // numbered list used to leave the numbers repeating (1, 2, 2, 3) and
  // deleting left a gap. Bullets are untouched.
  function renumberOrderedListAround(line: HTMLElement | null): void {
    if (!line) return
    const isNumbered = (el: Element | null) => !!el
      && (el as HTMLElement).dataset?.kind === 'list-item'
      && /^\d+[.)] /.test((el as HTMLElement).textContent || '')
    if (!isNumbered(line)) return

    let first: HTMLElement = line
    while (isNumbered(first.previousElementSibling)) first = first.previousElementSibling as HTMLElement
    const block: HTMLElement[] = []
    for (let el: HTMLElement | null = first; el && isNumbered(el); el = el.nextElementSibling as HTMLElement | null) {
      block.push(el)
    }

    // Keep whichever delimiter the writer chose, and start from their first
    // number rather than forcing 1 — a list may deliberately begin at 0 or 5.
    const head = (block[0].textContent || '').match(/^(\d+)([.)]) /)
    if (!head) return
    const start = parseInt(head[1], 10)
    const delim = head[2]
    block.forEach((el, i) => {
      const text = el.textContent || ''
      const want = `${start + i}${delim} `
      const rest = text.replace(/^\d+[.)] /, '')
      if (`${want}${rest}` === text) return
      const caret = getCursorOffsetInLine(el)
      adoptLine(el, buildLineEl(`${want}${rest}`, 'list-item'))
      if (caret !== null) setCursorOffsetInLine(el, Math.min(caret, (el.textContent || '').length))
    })
  }

  // Re-classify every line and clean up structure. Runs on every input
  // event; the common case is "no structural change" and touches nothing.
  // When a marker is typed or broken, the affected line — and for code
  // fences every line that follows — is rebuilt in place, caret kept.
  function reclassifyLines(): void {
    // The browser sometimes leaves bare text nodes, stray <br>s or foreign
    // elements (a <p> from a paste) at the root. Wrap them as lines so the
    // per-line model stays consistent; classifyLines below gives the real
    // kind.
    for (const node of Array.from(docEl.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        docEl.replaceChild(buildLineEl(node.textContent || '', 'body'), node)
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement
        if (el.tagName === 'BR') docEl.replaceChild(buildLineEl('', 'body'), node)
        else if (!el.classList.contains(LINE)) docEl.replaceChild(buildLineEl(el.textContent || '', 'body'), node)
      }
    }
    const lines = Array.from(docEl.children) as HTMLElement[]
    const texts = lines.map((l) => l.textContent || '')
    // The line holding the caret gets two things no other line does:
    // classifyLines returns it as `source` if it would otherwise be markup
    // from end to end, and buildLineEl shows the source of any link on it.
    // Both exist so the writer can see and edit characters hidden
    // everywhere else.
    let caretLineIdx = -1
    const sel = window.getSelection()
    const anchor = sel && sel.rangeCount > 0 ? sel.anchorNode : null
    if (anchor) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].contains(anchor)) { caretLineIdx = i; break }
      }
    }
    const kinds = classifyLines(texts, caretLineIdx)
    for (let idx = 0; idx < lines.length; idx++) {
      const el = lines[idx]
      const reveal = idx === caretLineIdx
      if (!lineMatchesModel(el, kinds[idx], reveal)) rebuildLineInPlace(el, kinds[idx], reveal)
      // Empty lines keep a <br> filler.
      if ((el.textContent || '') === '' && !el.querySelector('br')) el.appendChild(document.createElement('br'))
    }
    // A document emptied entirely keeps one empty line for the caret.
    if (docEl.children.length === 0) docEl.appendChild(buildLineEl('', 'body'))
    applyTableLayout(docEl)
  }

  // Two things on the caret's line show their source while it is there
  // and hide it again once the caret leaves: a line that is marker from
  // end to end (a fence, a rule, a table's delimiter row), and any link.
  // The caret can arrive by click or arrow key, neither of which fires
  // `input`, so this runs on every selectionchange — and has to be cheap:
  // one attribute query, one walk up from the anchor, and a regex only on
  // the caret's line. The reclassify behind it runs only on a crossing.
  function refreshCaretLineReveal(): void {
    const sel = window.getSelection()
    const anchor = sel && sel.rangeCount > 0 ? sel.anchorNode : null
    const line = anchor ? lineElOf(anchor) : null
    const open = docEl.querySelector<HTMLElement>(`.${LINE}[data-kind="source"], .${LINE}[data-reveal="links"]`)
    if (open && open !== line) { reclassifyLines(); return }
    if (!line) return
    if (isWhollyHidden(kindOf(line))
        || (line.dataset.reveal !== 'links' && LINK_HINT_RE.test(line.textContent || ''))) {
      reclassifyLines()
    }
  }

  // ── Bold ──────────────────────────────────────────────────────────
  //
  // ⌘B. Four behaviours:
  //   - Collapsed caret inside bold: exit bold mode. The caret moves to
  //     just after the run and typing continues plain (beforeinput catches
  //     the next keystroke).
  //   - Selection inside bold: split the run. The selected part becomes
  //     plain; what sat before and after stays bold.
  //   - Selection elsewhere: wrap it in `**…**`.
  //   - Collapsed caret elsewhere: insert `****` and park between the pairs.
  function toggleBoldAtSelection(): void {
    const sel = window.getSelection()
    const range = selectionIn(docEl)
    if (!sel || !range) return

    const strong = strongAncestorOf(docEl, range.commonAncestorContainer)
    // The run-splitting branches rewrite the DOM directly rather than
    // through insertText, so no beforeinput fires to snapshot for us.
    if (strong && !range.collapsed) recordHistoryPoint()
    if (strong) {
      if (range.collapsed) {
        const r = document.createRange()
        r.setStartAfter(strong)
        r.collapse(true)
        sel.removeAllRanges()
        sel.addRange(r)
        return
      }
      // The selection must sit wholly inside the strong's inner text node
      // (a double-click, shift-arrow or drag inside the run). Anything
      // wider falls back to unwrapping the whole run.
      const inner = strong.childNodes[1]
      if (!inner || inner.nodeType !== Node.TEXT_NODE
          || range.startContainer !== inner || range.endContainer !== inner) {
        const innerText = (inner && inner.nodeType === Node.TEXT_NODE) ? (inner.textContent || '') : ''
        const textNode = document.createTextNode(innerText)
        strong.parentNode!.replaceChild(textNode, strong)
        const r = document.createRange()
        r.setStart(textNode, innerText.length)
        r.collapse(true)
        sel.removeAllRanges()
        sel.addRange(r)
        reclassifyLines()
        changed()
        return
      }
      const innerText = inner.textContent || ''
      const selStart = Math.min(range.startOffset, range.endOffset)
      const selEnd = Math.max(range.startOffset, range.endOffset)
      const beforeRun = innerText.slice(0, selStart) ? wrapBoldPreservingEdgeSpace(innerText.slice(0, selStart)) : ''
      const selected = innerText.slice(selStart, selEnd)
      const afterRun = innerText.slice(selEnd) ? wrapBoldPreservingEdgeSpace(innerText.slice(selEnd)) : ''
      // The caret lands at the end of the now-plain run. Measured from the
      // built runs: wrapping may move whitespace outside the markers or
      // decline to wrap a whitespace-only run.
      const replacementNode = document.createTextNode(beforeRun + selected + afterRun)
      strong.parentNode!.replaceChild(replacementNode, strong)
      const r = document.createRange()
      r.setStart(replacementNode, beforeRun.length + selected.length)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      reclassifyLines()
      changed()
      return
    }

    asOneStep(() => {
      if (range.collapsed) {
        document.execCommand('insertText', false, '****')
        // modify() is non-standard but supported in all current browsers; a
        // missing implementation leaves the caret after the four asterisks.
        try {
          sel.modify('move', 'backward', 'character')
          sel.modify('move', 'backward', 'character')
        } catch { /* caret stays after **** */ }
      } else {
        document.execCommand('insertText', false, wrapBoldPreservingEdgeSpace(sel.toString()))
      }
    })
  }

  // An edit made through execCommand fires `input` but never `beforeinput`,
  // so the usual recorder never sees its pre-state and the edit would fold
  // into whatever typing came before it. Snapshot first, and keep the input
  // handler from recording the same step again.
  function asOneStep(run: () => void): void {
    recordHistoryPoint()
    historySuppress = true
    try { run() } finally { historySuppress = false }
  }

  // ── Table editing ─────────────────────────────────────────────────
  //
  // Everything below works in source-offset coordinates and rebuilds
  // through the same reclassify pass as the rest of the editor, so a
  // table row is never a special case for save, undo or annotations.

  // Every table gesture rewrites the DOM directly rather than going
  // through beforeinput, so each one closes the post-edit loop itself.
  function afterTableEdit(): void {
    reclassifyLines()
    changed()
  }

  function insertTableRowAfter(anchor: HTMLElement, columns: number): HTMLElement {
    const row = buildLineEl(emptyTableRowText(columns), 'table-row')
    anchor.parentNode!.insertBefore(row, anchor.nextSibling)
    return row
  }

  // Enter inside a table, and the one gesture that creates a table.
  function handleTableEnter(): boolean {
    const range = selectionIn(docEl)
    if (!range || !range.collapsed) return false
    const line = lineElOf(range.startContainer)
    if (!line || line.parentElement !== docEl) return false
    const kind = kindOf(line)
    const text = line.textContent || ''

    if (isTableRowKind(kind)) {
      const parts = splitTableRow(text)
      if (!parts) return false
      // A trailing blank row means the writer is done with the table, the
      // same way a blank list item ends a list: the row goes and an empty
      // paragraph takes its place.
      if (kind === 'table-row' && parts.cells.every((c) => c === '') && !nextTableRowLine(line)) {
        recordHistoryPoint()
        const fresh = buildLineEl('', 'body')
        line.replaceWith(fresh)
        setCursorOffsetInLine(fresh, 0)
        afterTableEdit()
        return true
      }
      recordHistoryPoint()
      // From the header the new row belongs under the delimiter.
      const anchor = kind === 'table-head'
        ? (line.nextElementSibling as HTMLElement | null) ?? line
        : line
      placeCaretInTableCell(insertTableRowAfter(anchor, parts.cells.length), 0)
      afterTableEdit()
      return true
    }

    // A finished pipe line that isn't a table yet: write the delimiter row
    // for it. Typing `| --- | --- |` by hand is the least loved part of
    // table markdown, and a wrong column count is the usual reason a table
    // renders as prose.
    if (kind === 'body' && isTableRowText(text)) {
      const offset = offsetInLineFor(line, range.startContainer, range.startOffset)
      if (offset !== text.length) return false
      const parts = splitTableRow(text)
      if (!parts) return false
      const below = line.nextElementSibling as HTMLElement | null
      if (below && isTableDelimText(below.textContent || '')) return false
      recordHistoryPoint()
      const delim = buildLineEl(tableDelimTextFor(parts.cells.length), 'table-delim')
      line.parentNode!.insertBefore(delim, line.nextSibling)
      placeCaretInTableCell(insertTableRowAfter(delim, parts.cells.length), 0)
      afterTableEdit()
      return true
    }
    return false
  }

  // Tab / Shift+Tab walk the cells. Inside a table the key never reaches
  // the browser's focus handling — losing the caret to the next control
  // mid-table would be far worse than a swallowed Tab.
  function handleTableTab(back: boolean): boolean {
    const range = selectionIn(docEl)
    if (!range) return false
    const line = lineElOf(range.startContainer)
    if (!line || line.parentElement !== docEl) return false
    if (!isTableRowKind(kindOf(line))) return false
    const spans = tableCellSpans(line.textContent || '')
    if (spans.length === 0) return false

    const offset = offsetInLineFor(line, range.startContainer, range.startOffset)
    let index = spans.findIndex((s) => offset >= s.start && offset <= s.end)
    // A caret parked inside a pipe belongs to whichever edge we're heading
    // away from.
    if (index < 0) index = back ? spans.length - 1 : 0

    if (back) {
      if (index > 0) { placeCaretInTableCell(line, index - 1, 'end'); return true }
      const prev = prevTableRowLine(line)
      if (prev) placeCaretInTableCell(prev, tableCellSpans(prev.textContent || '').length - 1, 'end')
      return true
    }
    if (index < spans.length - 1) { placeCaretInTableCell(line, index + 1, 'end'); return true }
    const next = nextTableRowLine(line)
    if (next) { placeCaretInTableCell(next, 0, 'end'); return true }
    // Past the last cell of the last row — grow the table. The anchor is
    // the block's last line so tabbing out of a header with no body rows
    // yet lands below the delimiter.
    recordHistoryPoint()
    placeCaretInTableCell(insertTableRowAfter(lastTableLineOf(line), spans.length), 0)
    afterTableEdit()
    return true
  }

  // Up / Down inside a table. Every cell is a grid item, so Chrome counts
  // each one as a line of its own and walks the row cell by cell before
  // dropping to the next. Move by column instead, and leave movement inside
  // a wrapped cell to the browser.
  function handleTableVerticalMove(down: boolean): boolean {
    const range = selectionIn(docEl)
    if (!range || !range.collapsed) return false
    const line = lineElOf(range.startContainer)
    if (!line || line.parentElement !== docEl) return false
    if (!isTableRowKind(kindOf(line))) return false

    const spans = tableCellSpans(line.textContent || '')
    const offset = offsetInLineFor(line, range.startContainer, range.startOffset)
    const index = spans.findIndex((s) => offset >= s.start && offset <= s.end)
    if (index < 0) return false
    const cell = line.querySelectorAll<HTMLElement>(`:scope > .${CELL}`)[index]
    if (cell && !caretAtCellEdge(range, cell, down)) return false

    // Nothing above or below inside the table: let the default carry the
    // caret out into the prose.
    const target = down ? nextTableRowLine(line) : prevTableRowLine(line)
    if (!target) return false
    const targetSpans = tableCellSpans(target.textContent || '')
    const to = targetSpans[Math.min(index, targetSpans.length - 1)]
    if (!to) return false
    // Hold the same depth into the cell, so arrowing down a column of
    // similar values keeps reading as a column.
    setCursorOffsetInLine(target, Math.min(to.start + (offset - spans[index].start), to.end))
    return true
  }

  // Backspace / Delete sitting on a cell boundary. Chrome treats the
  // hidden pipe between two cells as zero-width and deletes straight
  // through it, silently welding two columns together. Owning both
  // boundary positions means the row's shape only changes deliberately:
  //   - into a neighbouring cell that has content: eat one character of it
  //   - into an empty row: drop that row
  //   - into an empty cell, or across a row boundary: step the caret over
  //   - at the outer edge of the first / last row: drop the outer pipe, so
  //     the row falls out of the table (at the top-left corner, this is
  //     how a whole table is unmade).
  // 'moved' and 'edited' are told apart so caret-only cases don't leave an
  // undo step behind that undoes nothing.
  function handleTableBoundaryDelete(line: HTMLElement, forward: boolean, offset: number): BoundaryDelete {
    const text = line.textContent || ''
    const kind = kindOf(line)
    const spans = tableCellSpans(text)
    const index = spans.findIndex((s) => offset >= s.start && offset <= s.end)
    if (index < 0) return false

    const step = (target: HTMLElement, cellIndex: number, at: 'start' | 'end'): BoundaryDelete => {
      placeCaretInTableCell(target, cellIndex, at)
      return 'moved'
    }
    const dropRowInto = (row: HTMLElement, target: HTMLElement): BoundaryDelete => {
      recordHistoryPoint()
      row.remove()
      placeCaretInTableCell(target, tableCellSpans(target.textContent || '').length - 1, 'end')
      afterTableEdit()
      return 'edited'
    }
    const isBlankRow = (row: HTMLElement): boolean => {
      const parts = splitTableRow(row.textContent || '')
      return !!parts && parts.cells.every((c) => c === '')
    }
    // replaceSourceRange reclassifies on its own; the rest of the post-edit
    // loop still has to run.
    const cut = (from: number, to: number): BoundaryDelete => {
      recordHistoryPoint()
      replaceSourceRange(line, from, line, to, '')
      changed()
      return 'edited'
    }

    if (!forward && offset === spans[index].start) {
      if (index > 0) {
        const before = spans[index - 1]
        return before.end > before.start ? cut(before.end - 1, before.end) : step(line, index - 1, 'end')
      }
      const prev = prevTableRowLine(line)
      if (!prev) return cut(0, blockMarkerLength(kind, text))
      if (kind === 'table-row' && isBlankRow(line)) return dropRowInto(line, prev)
      return step(prev, tableCellSpans(prev.textContent || '').length - 1, 'end')
    }

    if (forward && offset === spans[index].end) {
      if (index < spans.length - 1) {
        const after = spans[index + 1]
        return after.end > after.start ? cut(after.start, after.start + 1) : step(line, index + 1, 'start')
      }
      const next = nextTableRowLine(line)
      if (!next) return cut(text.length - blockTrailingMarkerLength(kind, text), text.length)
      if (isBlankRow(next)) return dropRowInto(next, line)
      return step(next, 0, 'start')
    }
    return false
  }

  // ── Lists ─────────────────────────────────────────────────────────
  //
  // Enter inside a list item continues the list:
  //   - Empty item (just the marker): exit the list; the line becomes body.
  //   - Caret past the marker: split here; the new item gets `- ` or the
  //     next number, and the caret lands after it.
  //   - Caret inside the marker: leave the default alone.
  function handleListEnter(event: KeyboardEvent): boolean {
    const sel = window.getSelection()
    const range = selectionIn(docEl)
    if (!sel || !range || !range.collapsed) return false
    const line = lineElOf(range.startContainer)
    if (!line || line.dataset.kind !== 'list-item') return false
    const lineText = line.textContent || ''
    const markerMatch = lineText.match(/^(?:- |\d+[.)] )/)
    if (!markerMatch) return false
    // These branches rewrite the DOM directly, so no beforeinput records
    // them. Without this the new item could not be undone at all.
    recordHistoryPoint()
    const marker = markerMatch[0]
    const markerLen = marker.length
    const cursorOffset = getCursorOffsetInLine(line) ?? 0
    if (lineText.length <= markerLen) {
      event.preventDefault()
      while (line.firstChild) line.removeChild(line.firstChild)
      line.dataset.kind = 'body'
      delete line.dataset.listMarker
      line.appendChild(document.createElement('br'))
      const r = document.createRange()
      r.setStart(line, 0)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      reclassifyLines()
      renumberOrderedListAround(line)
      changed()
      return true
    }
    if (cursorOffset < markerLen) return false
    event.preventDefault()
    const before = lineText.slice(0, cursorOffset)
    const after = lineText.slice(cursorOffset)
    let newMarker = '- '
    const numMatch = marker.match(/^(\d+)([.)]) /)
    if (numMatch) newMarker = `${parseInt(numMatch[1], 10) + 1}${numMatch[2]} `
    adoptLine(line, buildLineEl(before, classifyLines([before])[0]))
    const newLineText = newMarker + after
    const newLine = buildLineEl(newLineText, classifyLines([newLineText])[0])
    line.parentNode!.insertBefore(newLine, line.nextSibling)
    setCursorOffsetInLine(newLine, newMarker.length)
    reclassifyLines()
    renumberOrderedListAround(line)
    changed()
    return true
  }

  // ── Event handlers ────────────────────────────────────────────────

  // Make the browser use <div> (not <p> or <br>) for paragraph splits on
  // Enter. Some browsers ignore it; reclassifyLines wraps anything else.
  try { document.execCommand('defaultParagraphSeparator', false, 'div') } catch { /* ignore */ }

  // While frozen, nothing reaches the handlers below.
  for (const type of ['keydown', 'beforeinput', 'paste', 'cut', 'drop'] as const) {
    listen(docEl, type, (event: Event) => {
      if (frozen) { event.preventDefault(); event.stopImmediatePropagation() }
    }, true)
  }

  let dragSource: DragSource | null = null

  listen(docEl, 'beforeinput', (e: InputEvent) => {
    const t = e.inputType
    // Native rich-text formatting would wrap the selection in <b>/<i>/<u>;
    // in a markdown editor the writer types `**bold**` instead.
    if (t === 'formatBold' || t === 'formatItalic' || t === 'formatUnderline'
        || t === 'formatStrikeThrough' || t === 'formatSuperscript' || t === 'formatSubscript') {
      e.preventDefault()
      return
    }

    // Snapshot the pre-edit document for undo before anything mutates.
    noteHistoryPre()

    // Any edit that crosses a line boundary has to be done in source
    // coordinates — see replaceSourceRange for why.
    const isDelete = t === 'deleteContentBackward' || t === 'deleteContentForward'
      || t === 'deleteByCut' || t === 'deleteByDrag'
      || t === 'deleteWordBackward' || t === 'deleteWordForward'
    const isPlainInsert = t === 'insertText' || t === 'insertReplacementText'
      || t === 'insertFromPaste' || t === 'insertFromDrop'
    // Enter over a multi-line selection both deletes across a boundary and
    // splits a line; the native path re-serialises the moved paragraph
    // without the hidden markers.
    const isBreak = t === 'insertParagraph' || t === 'insertLineBreak'
    if (isDelete || isPlainInsert || isBreak) {
      const range = selectionIn(docEl)
      if (range) {
        const startLine = lineElOf(range.startContainer)
        const endLine = lineElOf(range.endContainer)
        if (startLine && endLine && startLine !== endLine) {
          const insert = isDelete ? ''
            : isBreak ? '\n'
            : (e.dataTransfer?.getData('text/plain') ?? e.data ?? '')
          e.preventDefault()
          replaceSourceRange(
            startLine, offsetInLineFor(startLine, range.startContainer, range.startOffset),
            endLine, offsetInLineFor(endLine, range.endContainer, range.endOffset),
            insert,
          )
          changed()
          commitHistoryBatch(true)
          return
        }
      }
    }

    // Collapsed caret on a line boundary. Backward at the start of a line
    // strips its block marker if it has one, else joins it onto the line
    // above; forward at the end of a line pulls the next line up.
    if (t === 'deleteContentBackward' || t === 'deleteContentForward') {
      const range = selectionIn(docEl)
      if (range && range.collapsed) {
        const line = lineElOf(range.startContainer)
        if (line && line.parentElement === docEl) {
          const kind = kindOf(line)
          const text = line.textContent || ''
          const markerLen = blockMarkerLength(kind, text)
          const off = offsetInLineFor(line, range.startContainer, range.startOffset)
          const hasBlockMarker = markerLen > 0 && hasStrippableMarker(kind)
          const boundary = isTableRowKind(kind)
            ? handleTableBoundaryDelete(line, t === 'deleteContentForward', off)
            : false
          if (boundary) {
            e.preventDefault()
            if (boundary === 'edited') commitHistoryBatch(true)
            return
          }
          if (t === 'deleteContentBackward' && off <= markerLen && hasBlockMarker) {
            e.preventDefault()
            stripBlockMarker(line)
            changed()
            commitHistoryBatch(true)
            return
          }
          if (t === 'deleteContentBackward' && off === 0 && line.previousElementSibling) {
            e.preventDefault()
            mergeLineBackward(line)
            changed()
            commitHistoryBatch(true)
            return
          }
          if (t === 'deleteContentForward' && off === text.length && line.nextElementSibling) {
            e.preventDefault()
            mergeLineBackward(line.nextElementSibling as HTMLElement)
            changed()
            commitHistoryBatch(true)
            return
          }
        }
      }
    }

    // Retyping a block marker over an existing one. The caret snaps past a
    // hidden marker, so a `#` typed at the visible start of a heading landed
    // *after* it and a heading's level could not be changed by typing.
    // Typing `#` there now replaces the existing marker and starts a new
    // one, so `## Heading` + `#` + space reads as H1.
    if (t === 'insertText' && e.data === '#') {
      const range = selectionIn(docEl)
      if (range && range.collapsed) {
        const line = lineElOf(range.startContainer)
        if (line && line.parentElement === docEl) {
          const kind = kindOf(line)
          const markerLen = blockMarkerLength(kind, line.textContent || '')
          if (markerLen > 0 && hasStrippableMarker(kind)
              && offsetInLineFor(line, range.startContainer, range.startOffset) === markerLen) {
            e.preventDefault()
            noteHistoryPre()
            replaceSourceRange(line, 0, line, markerLen, '#')
            changed()
            commitHistoryBatch(true)
            return
          }
        }
      }
    }

    // Typing at the trailing edge of a bold or code run: put the text in a
    // fresh sibling node so it comes out plain (see inlineWrapAtCaretEdge).
    if ((t === 'insertText' || t === 'insertCompositionText') && typeof e.data === 'string') {
      const sel = window.getSelection()
      const range = selectionIn(docEl)
      if (!sel || !range || !range.collapsed) return
      const wrap = inlineWrapAtCaretEdge(range)
      if (!wrap) return
      e.preventDefault()
      const lineLevel = wrap.parentNode!
      const newText = document.createTextNode(e.data)
      lineLevel.insertBefore(newText, wrap.nextSibling)
      const r = document.createRange()
      r.setStart(newText, newText.textContent!.length)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      // A prevented insertion fires no 'input', so run the post-edit loop
      // here, and keep coalescing the undo step like ordinary typing.
      reclassifyLines()
      changed()
      commitHistoryBatch(false)
      return
    }

    // Delete/Backspace next to a hidden marker. Chrome treats a
    // display:none marker span as zero-width and consumes it together with
    // the visible character on its other side (`# H|eading` + Backspace →
    // `eading`). Delete just the one visible character and leave the
    // marker, so the line keeps its kind. Inline markers (`**`, `` ` ``)
    // get the same treatment.
    if (t === 'deleteContentForward' || t === 'deleteContentBackward') {
      const sel = window.getSelection()
      const range = selectionIn(docEl)
      if (!sel || !range || !range.collapsed) return
      const a = range.startContainer
      if (a.nodeType !== Node.TEXT_NODE) return
      if (range.startOffset !== (t === 'deleteContentForward' ? 0 : 1)) return
      if (!isMarker(a.previousSibling)) return
      const txt = a as Text
      if ((txt.data || '').length === 0) return
      e.preventDefault()
      txt.deleteData(0, 1)
      const r = document.createRange()
      r.setStart(txt, 0)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      reclassifyLines()
      changed()
      commitHistoryBatch(true)
    }
  })

  // Plain-text paste only: HTML would inject styles and tags to scrub.
  listen(docEl, 'paste', (e: ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain') || ''
    // execCommand called from a paste handler does not reliably deliver a
    // beforeinput of its own, so snapshot here; if one does fire, it takes
    // the same pre-state and the extra commit is a no-op.
    noteHistoryPre()
    document.execCommand('insertText', false, text)
    commitHistoryBatch(true)
  })

  // Remember what was picked up, so an in-document drag can move rather
  // than copy: the drop handler cancels the default that would have
  // removed the source.
  listen(docEl, 'dragstart', () => {
    const range = selectionIn(docEl)
    if (!range || range.collapsed) { dragSource = null; return }
    const startLine = lineElOf(range.startContainer)
    const endLine = lineElOf(range.endContainer)
    if (!startLine || !endLine) { dragSource = null; return }
    dragSource = {
      startLine, endLine,
      startOffset: offsetInLineFor(startLine, range.startContainer, range.startOffset),
      endOffset: offsetInLineFor(endLine, range.endContainer, range.endOffset),
    }
  })
  listen(docEl, 'dragend', () => { dragSource = null })

  listen(docEl, 'drop', (e: DragEvent) => {
    e.preventDefault()
    const text = e.dataTransfer?.getData('text/plain') || ''
    const source = dragSource
    dragSource = null
    if (!text) return
    noteHistoryPre()

    // Insert where the pointer is, not where the selection happens to be.
    const at = caretRangeFromPoint(e.clientX, e.clientY)
    const dropLine = at ? lineElOf(at.startContainer) : null
    if (!at || !dropLine || dropLine.parentElement !== docEl) return
    const dropOffset = offsetInLineFor(dropLine, at.startContainer, at.startOffset)
    const dropIndex = Array.prototype.indexOf.call(docEl.children, dropLine)

    if (source) {
      // In-document move: remove the original first, then insert at the
      // drop point. When the removal was earlier on the same line, the drop
      // offset shifts left by however much came out.
      const sameLine = source.startLine === dropLine
      const removed = sameLine && source.endOffset <= dropOffset ? source.endOffset - source.startOffset : 0
      replaceSourceRange(source.startLine, source.startOffset, source.endLine, source.endOffset, '')
      const target = (docEl.children[Math.min(dropIndex, docEl.children.length - 1)] as HTMLElement | undefined) || null
      if (target) {
        const offset = Math.max(0, Math.min(dropOffset - removed, (target.textContent || '').length))
        replaceSourceRange(target, offset, target, offset, text)
      }
    } else {
      replaceSourceRange(dropLine, dropOffset, dropLine, dropOffset, text)
    }
    changed()
    commitHistoryBatch(true)
  })

  listen(docEl, 'copy', (e: ClipboardEvent) => {
    const range = selectionIn(docEl)
    if (!range || range.collapsed) return
    e.preventDefault()
    e.clipboardData?.setData('text/plain', reconstructMarkdownFromRange(docEl, range))
  })

  // Cut is copy + delete, both in source coordinates: exactly the spans that
  // went to the clipboard leave the document, markers included, and the
  // removal is one undo step. (A native delete fires no beforeinput, so it
  // would bypass the cross-line handling above and drop hidden markers.)
  listen(docEl, 'cut', (e: ClipboardEvent) => {
    const range = selectionIn(docEl)
    if (!range || range.collapsed) return
    const spans = selectedSpans(docEl, range)
    e.preventDefault()
    e.clipboardData?.setData('text/plain', reconstructMarkdownFromRange(docEl, range))
    if (!spans.length) return
    const first = spans[0]
    const last = spans[spans.length - 1]
    recordHistoryPoint()
    replaceSourceRange(first.line, first.start, last.line, first.line === last.line ? Math.max(first.start, last.end) : last.end, '')
    changed()
  })

  listen(docEl, 'input', (e: Event) => {
    reclassifyLines()
    changed()
    // Plain typing coalesces into one undo step; anything structural
    // (Enter, delete, paste) ends the step where it happened.
    const t = (e as InputEvent).inputType || ''
    commitHistoryBatch(!(t === 'insertText' || t === 'insertCompositionText'))
  })

  listen(docEl, 'keydown', (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      options.onCommand?.('save', e)
    }
    if (mod && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault()
      options.onCommand?.('new', e)
    }
    // Own undo/redo outright — the native stack is incoherent here.
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (mod && (e.key === 'y' || e.key === 'Y') && !e.shiftKey) {
      e.preventDefault()
      redo()
      return
    }
    if (mod && (e.key === 'b' || e.key === 'B') && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      toggleBoldAtSelection()
    }
    // Right-arrow / End from the end of a bold's or code's inner text:
    // Chrome won't move the caret past hidden markers, so typing would keep
    // extending the run. Jump to the sentinel after the wrapper instead.
    if ((e.key === 'ArrowRight' || e.key === 'End') && !e.shiftKey && !mod && !e.altKey) {
      const sel = window.getSelection()
      const range = selectionIn(docEl)
      if (sel && range && range.collapsed) {
        const node = range.startContainer
        const parent = node.parentNode as HTMLElement | null
        if (node.nodeType === Node.TEXT_NODE && parent && isInlineWrap(parent)
            && range.startOffset === (node.textContent || '').length
            && isMarker(node.nextSibling)) {
          const sentinel = parent.nextSibling
          if (sentinel && sentinel.nodeType === Node.TEXT_NODE) {
            e.preventDefault()
            const r = document.createRange()
            r.setStart(sentinel, 0)
            r.collapse(true)
            sel.removeAllRanges()
            sel.addRange(r)
          }
        }
      }
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.shiftKey && !mod && !e.altKey) {
      if (handleTableVerticalMove(e.key === 'ArrowDown')) {
        e.preventDefault()
        return
      }
    }
    // Tab walks table cells and does nothing anywhere else: outside a table
    // the key keeps its "move focus on" meaning.
    if (e.key === 'Tab' && !mod && !e.altKey) {
      if (handleTableTab(e.shiftKey)) {
        e.preventDefault()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
      if (handleTableEnter()) {
        e.preventDefault()
        return
      }
      handleListEnter(e)
    }
  })

  const onSelectionChange = () => {
    if (document.activeElement !== docEl) {
      options.onSelectionChange?.(false)
      return
    }
    refreshCaretLineReveal()
    options.onSelectionChange?.(true)
  }
  document.addEventListener('selectionchange', onSelectionChange)
  cleanups.push(() => document.removeEventListener('selectionchange', onSelectionChange))

  loadIntoEditor('')

  // ── Public API ────────────────────────────────────────────────────

  function snapshot(): TextSnapshot {
    return snapshotOf(lineTexts())
  }

  function domRange(start: number, end: number, snap: TextSnapshot = snapshot()): Range | null {
    const lines = Array.from(docEl.children) as HTMLElement[]
    const startLineIdx = locateLine(snap.lineStarts, start)
    const endLineIdx = locateLine(snap.lineStarts, end)
    const startLine = lines[startLineIdx]
    const endLine = lines[endLineIdx]
    if (!startLine || !endLine) return null
    const s = textNodeAtOffset(startLine, start - snap.lineStarts[startLineIdx])
    const e = textNodeAtOffset(endLine, end - snap.lineStarts[endLineIdx])
    if (!s || !e) return null
    try {
      const range = document.createRange()
      range.setStart(s.node, s.offset)
      range.setEnd(e.node, e.offset)
      return range
    } catch {
      return null
    }
  }

  return {
    element: docEl,
    history: {
      reset: resetHistory,
      record: recordHistoryPoint,
      undo,
      redo,
      export: () => ({ current: captureHistoryEntry(), undo: historyUndo, redo: historyRedo }),
      import: (state) => {
        historyUndo = state.undo
        historyRedo = state.redo
      },
    },
    getText: serializeDoc,
    setText: loadIntoEditor,
    lines: () => Array.from(docEl.children) as HTMLElement[],
    snapshot,
    domRange,
    caret: caretSourcePosition,
    setCaret(line, offset) {
      const el = docEl.children[Math.max(0, Math.min(line, docEl.children.length - 1))] as HTMLElement | undefined
      if (el) setCursorOffsetInLine(el, Math.max(0, Math.min(offset, (el.textContent || '').length)))
    },
    placeCaretAtEnd: () => placeCaretAtEnd(docEl),
    focus: () => docEl.focus(),
    isEmpty: () => serializeDoc() === '',
    isFocused: () => document.activeElement === docEl,
    setEditable(editable) {
      docEl.contentEditable = editable ? 'true' : 'false'
    },
    setFrozen(value) {
      frozen = value
    },
    get frozen() { return frozen },
    destroy() {
      closeHistoryBatch()
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
}
