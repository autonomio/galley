// A note opens on the page, under its passage. The panel is never a child of
// the document element — every child of it is a source line — so it lives
// in a layer beside it, and the passage's last line makes room for it with a
// padding-bottom equal to the panel's height. A MutationObserver keeps the
// padding on exactly that line; a ResizeObserver on the panel and the
// document keeps panel and padding in step. Every move calls `moved`, so the
// marks are redrawn and never sit stale over the panel.
//
// One note is open at a time.
import { el } from './dom.js'
import { icons } from './icons.js'

export interface NoteOptions {
  id: string
  line: HTMLElement
  /** The passage's offsets on that line, to point the notch at it. */
  range: { start: number, end: number }
  value: string
  /** The passage can no longer be found in the document. */
  orphaned: boolean
  onInput(value: string): void
  onDelete(): void
  /** After it closed; `returnCaret` when the writer closed it from the keyboard. */
  onClose(returnCaret: boolean): void
}

interface OpenNote {
  options: NoteOptions
  panel: HTMLElement
  line: HTMLElement
  lineIndex: number
  mutations: MutationObserver
  resizes: ResizeObserver
}

export interface NotePanel {
  open(options: NoteOptions): void
  close(returnCaret?: boolean): void
  /** The id of the open note, if any. */
  current(): string | null
  layout(): void
}

const GAP = 16

export function createNotePanel(page: HTMLElement, doc: HTMLElement, moved: () => void): NotePanel {
  const layer = el('div', { class: 'galley-notes' })
  page.appendChild(layer)
  let open: OpenNote | null = null

  function lines(): HTMLElement[] {
    return Array.from(doc.children) as HTMLElement[]
  }

  function layout(): void {
    if (!open) return
    // The tracked line may be gone (its text was deleted or rebuilt). Fall
    // back to its index, clamped into the document.
    if (!open.line.isConnected) {
      const all = lines()
      if (!all.length) { open.panel.hidden = true; return }
      open.lineIndex = Math.max(0, Math.min(open.lineIndex, all.length - 1))
      open.line = all[open.lineIndex]
    }
    open.panel.hidden = false
    const height = open.panel.offsetHeight
    open.line.style.paddingBottom = `${height + GAP}px`
    const pageBox = page.getBoundingClientRect()
    const box = open.line.getBoundingClientRect()
    open.panel.style.top = `${box.bottom - pageBox.top - (height + GAP) + 8}px`
    // The notch points at the passage's first character: proportionally
    // across the line, clamped into the panel.
    const textLength = Math.max(1, open.line.textContent?.length || 1)
    const frac = Math.max(0, Math.min(1, open.options.range.start / textLength))
    const notch = open.panel.querySelector<HTMLElement>('.galley-note-notch')
    if (notch) notch.style.left = `${Math.max(12, Math.min(open.panel.offsetWidth - 12, box.left - pageBox.left + frac * box.width))}px`
    moved()
  }

  function close(returnCaret = false): void {
    if (!open) return
    const closing = open
    open = null
    closing.mutations.disconnect()
    closing.resizes.disconnect()
    if (closing.line.isConnected) closing.line.style.paddingBottom = ''
    for (const line of lines()) if (line.style.paddingBottom) line.style.paddingBottom = ''
    closing.panel.remove()
    moved()
    closing.options.onClose(returnCaret)
  }

  function openNote(options: NoteOptions): void {
    if (open?.options.id === options.id) return
    close()
    const panel = el('section', { class: 'galley-note', 'aria-label': 'Note' })
    panel.innerHTML = `
      <span class="galley-note-notch" aria-hidden="true"></span>
      <header class="galley-note-header">
        ${options.orphaned ? '<p class="galley-note-orphan">Passage changed: the text this note was on is no longer in the document.</p>' : ''}
        <button type="button" class="galley-note-btn is-danger" data-note="delete" aria-label="Delete note" title="Delete note">${icons.trash}</button>
        <button type="button" class="galley-note-btn" data-note="close" aria-label="Close note" title="Close (Esc)">${icons.close}</button>
      </header>
      <label class="galley-note-field">
        <span>Note</span>
        <textarea class="galley-note-text" rows="3" spellcheck="true"></textarea>
      </label>`
    const text = panel.querySelector<HTMLTextAreaElement>('.galley-note-text')!
    text.value = options.value
    text.addEventListener('input', () => options.onInput(text.value))
    panel.querySelector('[data-note="delete"]')!.addEventListener('click', () => options.onDelete())
    panel.querySelector('[data-note="close"]')!.addEventListener('click', () => close(true))
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
    })
    layer.appendChild(panel)

    const state: OpenNote = {
      options,
      panel,
      line: options.line,
      lineIndex: Math.max(0, lines().indexOf(options.line)),
      // Typing above the panel shifts lines without resizing anything, so
      // text changes reposition too. A native Enter split copies the inline
      // style onto the new line; strip it there.
      mutations: new MutationObserver(() => {
        if (!open) return
        for (const line of lines()) if (line !== open.line && line.style.paddingBottom) line.style.paddingBottom = ''
        layout()
      }),
      // Wrapping, font and window-size changes move lines without mutating.
      resizes: new ResizeObserver(() => layout()),
    }
    open = state
    state.mutations.observe(doc, { childList: true, subtree: true, characterData: true })
    state.resizes.observe(panel)
    state.resizes.observe(doc)
    layout()
    text.focus({ preventScroll: true })
    text.setSelectionRange(text.value.length, text.value.length)
  }

  return {
    open: openNote,
    close,
    current: () => open?.options.id ?? null,
    layout,
  }
}
