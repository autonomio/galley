// A note opens on the page, under its passage. The panel is never a child of
// the document element — every child of it is a source line — so it lives
// in a layer beside it, and the passage's last line makes room for it with a
// padding-bottom equal to the panel's height. A MutationObserver keeps the
// padding on exactly that line; a ResizeObserver on the panel and the
// document keeps panel and padding in step. Every move calls `moved`, so the
// marks are redrawn and never sit stale over the panel.
//
// A note with replies is a thread: who opened it and every answer are shown
// above the field, which then takes a reply instead of editing the opening
// comment. A thread can be resolved and reopened.
//
// One note is open at a time.
import type { AnnotationAuthor, AnnotationLabel, AnnotationReply } from '../types.js'
import { el, escapeHtml } from './dom.js'
import { icons } from './icons.js'

export interface ThreadView {
  /** Who opened it; null for the writer's own note. */
  author: AnnotationAuthor | null
  comment: string
  created_at: string
  replies: AnnotationReply[]
  labels: AnnotationLabel[]
  resolved: boolean
  /** The writer's name in the thread. */
  me: string
}

export interface NoteOptions {
  id: string
  line: HTMLElement
  /** The passage's offsets on that line, to point the notch at it. */
  range: { start: number, end: number }
  value: string
  /** The passage can no longer be found in the document. */
  orphaned: boolean
  /** Set for a thread; the field then takes replies. */
  thread?: ThreadView | null
  onInput(value: string): void
  onDelete(): void
  onReply?(text: string): void
  onResolve?(resolved: boolean): void
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
  /** Redraw the open thread's conversation, keeping whatever is being typed. */
  update(id: string, thread: ThreadView): void
  layout(): void
}

const GAP = 16

// Thread text is the agents' or the writer's prose: paragraphs, bold and code, nothing else.
export function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
}

function prose(text: string): string {
  return text.split(/\n\s*\n/).map((p) => `<p>${inline(p).replace(/\n/g, '<br>')}</p>`).join('')
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Who wrote it: an initial ringed in their tone, the writer's own in the accent. */
export function faceHtml(author: AnnotationAuthor | null, me: string): string {
  const name = author ? author.name : me
  const initial = (name.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase()
  const tone = author?.tone ? ` data-tone="${author.tone}"` : author?.kind === 'agent' ? '' : ' data-tone="me"'
  return `<span class="galley-thread-face"${tone} aria-hidden="true">${escapeHtml(initial)}</span>`
}

export function labelsHtml(labels: AnnotationLabel[]): string {
  return labels.map((l) => `<span class="galley-note-label"${l.tone ? ` data-tone="${l.tone}"` : ''}>${escapeHtml(l.text)}</span>`).join('')
}

function item(author: AnnotationAuthor | null, text: string, at: string, me: string): string {
  const name = author ? author.name : me
  return `<li class="galley-thread-item">
    ${faceHtml(author, me)}
    <div class="galley-thread-body">
      <div class="galley-thread-who"><b>${escapeHtml(name)}</b>${author?.detail ? `<span>${escapeHtml(author.detail)}</span>` : ''}<time>${when(at)}</time></div>
      <div class="galley-thread-text">${prose(text)}</div>
    </div>
  </li>`
}

function threadHtml(t: ThreadView): string {
  return item(t.author, t.comment, t.created_at, t.me) + t.replies.map((r) => item(r.author.kind === 'human' && r.author.name === t.me ? null : r.author, r.text, r.created_at, t.me)).join('')
}

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

  function drawThread(panel: HTMLElement, thread: ThreadView): void {
    const list = panel.querySelector<HTMLElement>('[data-note="thread"]')
    if (list) {
      // A new answer, yours or anyone's, is scrolled into view; a redraw with nothing new leaves the reader where they were.
      const grew = list.children.length > 0 && thread.replies.length + 1 > list.children.length
      list.innerHTML = threadHtml(thread)
      if (grew) list.scrollTop = list.scrollHeight
    }
    const labels = panel.querySelector<HTMLElement>('[data-note="labels"]')
    if (labels) labels.innerHTML = labelsHtml(thread.labels)
    const resolve = panel.querySelector<HTMLButtonElement>('[data-note="resolve"]')
    if (resolve) resolve.textContent = thread.resolved ? 'Reopen' : 'Resolve'
    panel.classList.toggle('is-resolved', thread.resolved)
  }

  function openNote(options: NoteOptions): void {
    if (open?.options.id === options.id) return
    close()
    const thread = options.thread ?? null
    const panel = el('section', { class: thread ? 'galley-note is-thread' : 'galley-note', 'aria-label': thread ? 'Thread' : 'Note' })
    // An agent's thread is the paper's record of a finding: it can be resolved, not deleted.
    const deletable = !thread || thread.author?.kind !== 'agent'
    panel.innerHTML = `
      <span class="galley-note-notch" aria-hidden="true"></span>
      <header class="galley-note-header">
        ${options.orphaned ? '<p class="galley-note-orphan">Passage changed: the text this note was on is no longer in the document.</p>' : ''}
        ${thread ? '<span class="galley-note-labels" data-note="labels"></span><button type="button" class="galley-note-resolve" data-note="resolve"></button>' : ''}
        ${deletable ? `<button type="button" class="galley-note-btn is-danger" data-note="delete" aria-label="Delete note" title="Delete note">${icons.trash}</button>` : ''}
        <button type="button" class="galley-note-btn" data-note="close" aria-label="Close note" title="Close (Esc)">${icons.close}</button>
      </header>
      ${thread ? '<ol class="galley-thread" data-note="thread"></ol>' : ''}
      <label class="galley-note-field">
        <span>${thread ? 'Reply' : 'Note'}</span>
        <textarea class="galley-note-text" rows="${thread ? 2 : 3}" spellcheck="true"></textarea>
      </label>
      ${thread ? '<div class="galley-note-actions"><button type="button" class="galley-note-reply" data-note="reply">Reply</button></div>' : ''}`
    const text = panel.querySelector<HTMLTextAreaElement>('.galley-note-text')!
    if (thread) {
      drawThread(panel, thread)
      const send = () => {
        const value = text.value.trim()
        if (!value) return
        text.value = ''
        options.onReply?.(value)
      }
      panel.querySelector('[data-note="reply"]')!.addEventListener('click', send)
      text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } })
      panel.querySelector('[data-note="resolve"]')!.addEventListener('click', () => options.onResolve?.(!panel.classList.contains('is-resolved')))
    } else {
      text.value = options.value
      text.addEventListener('input', () => options.onInput(text.value))
    }
    panel.querySelector('[data-note="delete"]')?.addEventListener('click', () => options.onDelete())
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
    update(id, thread) {
      if (!open || open.options.id !== id || !open.panel.classList.contains('is-thread')) return
      drawThread(open.panel, thread)
      layout()
    },
    layout,
  }
}
