// createEditor: the writing surface, the open document's session, notes and
// chrome, put together. This file is orchestration only; each piece it wires
// lives in its own module:
//
//   surface/surface.ts   the contenteditable surface (text, caret, undo)
//   editor/session.ts    persistence: versions, save queues, beacons
//   editor/marks.ts      note underlines and highlights
//   editor/notes.ts      the note panel under a passage
//   editor/selection.ts  the floating selection actions
//   editor/toolbar.ts    header actions; editor/doc-picker.ts the picker
//   editor/status.ts     the status line and notices
import { reAnchor, sameRange } from '../core/anchoring.js'
import { applyEdit, findEditRange } from '../core/edits.js'
import { HistoryTooLargeError, readHistory, writeHistory, type HistoryEntry, type HistoryStore } from '../core/history.js'
import { IMPORT_MAX_BYTES, decodeMarkdownImport } from '../core/import.js'
import { merge3 } from '../core/merge.js'
import { randomId } from '../core/slug.js'
import { countWords, locateLine } from '../core/text.js'
import { UNTITLED } from '../markdown/title.js'
import { createSurface, type Surface } from '../surface/surface.js'
import type { DocumentStore } from '../stores/types.js'
import type { Annotation, AnnotationRange, DocSummary, EditOutcome, EditProposal, Version } from '../types.js'
import { Emitter, el } from './dom.js'
import { createDocPicker, type DocPicker } from './doc-picker.js'
import { icons } from './icons.js'
import { drawHighlight, pageRects, renderAnnotationMarks } from './marks.js'
import { createNotePanel, type ThreadView } from './notes.js'
import { createSelectionCluster, type ClusterAction, type SelectedPassage } from './selection.js'
import { DocumentSession, type Notice, type SaveState } from './session.js'
import { createNoticeStack, createStatusLine } from './status.js'
import { confirmOn, createToolbar, type Toolbar, type ToolbarAction } from './toolbar.js'

export type { Notice, SaveState } from './session.js'
export type { SelectedPassage } from './selection.js'

/** A header button. Built-ins are named by id; hosts add their own. */
export type EditorAction = ToolbarAction<Editor>
export type BuiltinAction = 'writer' | 'new' | 'import' | 'copy' | 'delete'

/** A floating action on selected text. */
export interface SelectionAction {
  id: string
  label: string
  icon: string
  run(passage: SelectedPassage & { slug: string }, editor: Editor): void | Promise<void>
}
export type BuiltinSelectionAction = 'comment'

/** Extends an editor: subscribe to events, add layers, return a cleanup. */
export type EditorPlugin = (editor: Editor) => void | (() => void)

export interface EditorEvents {
  /** A document was opened. */
  open: { slug: string }
  /** The writer edited the open document. */
  change: { slug: string }
  status: { state: SaveState }
  notice: Notice
  /** The document list changed. */
  documents: { documents: DocSummary[] }
  /** Marks were redrawn: reposition anything drawn over the page. */
  layout: Record<string, never>
  'writer-mode': { on: boolean }
  /** Notes were added, changed or removed. */
  annotations: { annotations: Annotation[] }
}

export interface EditorOptions {
  store: DocumentStore
  /** Header actions, in order. Default: writer, new, import, copy, delete. */
  toolbar?: (BuiltinAction | EditorAction)[]
  /** Selection actions, in order. Default: comment. */
  selectionActions?: (BuiltinSelectionAction | SelectionAction)[]
  /** Show the document picker. Default true. */
  picker?: boolean
  /** Notes on passages. Default true. */
  comments?: boolean
  plugins?: EditorPlugin[]
  /** Open this document first instead of the last one opened. */
  open?: string
  /** Prefix for browser storage keys. Default `galley`. */
  storagePrefix?: string
  /** Where undo history and the last-opened document are kept; null to keep neither. */
  storage?: {
    history?: HistoryStore | null
    local?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  }
  /** Show notices yourself instead of in the editor's own stack. */
  notify?: (notice: Notice) => void
  /** Ask the writer a yes/no question. Default window.confirm. */
  confirm?: (message: string) => boolean | Promise<boolean>
  theme?: 'dark' | 'light'
  /** Shown in an empty document. */
  placeholder?: string
  /** Debounce before a save, in ms. Default 500. */
  saveDelay?: number
  /** The writer's name in threads. Default `You`. */
  me?: string
}

export interface Editor {
  readonly root: HTMLElement
  readonly surface: Surface
  /** The page column, for anything a plugin positions over the text. */
  readonly page: HTMLElement
  /** Resolves once the first document is open. */
  readonly ready: Promise<void>
  readonly slug: string | null
  documents(): DocSummary[]
  /** The open document's markdown. */
  text(): string
  open(slug: string): Promise<void>
  create(): Promise<void>
  importFile(file: File): Promise<void>
  /** Delete the open document, after asking. */
  remove(): Promise<void>
  copy(): Promise<boolean>
  /** Save everything pending. False when something could not be saved. */
  flush(): Promise<boolean>
  hasUnsavedChanges(): boolean
  /** Persist undo history now (the editor also does this on pagehide). */
  persistHistory(): 'kept' | 'trimmed' | 'too-large' | 'unavailable'
  refresh(): Promise<boolean>
  writerMode(): boolean
  setWriterMode(on: boolean): void
  /** Hold the text still while something else owns it: no edits, no saves. */
  setFrozen(frozen: boolean): void
  /** The store changed the open document itself; show its text and adopt its version. */
  adopt(slug: string, content: string, version: Version): void
  /**
   * Another writer changed the open document (an agent, another tab): merge
   * their text into the page without moving the caret, as one undo step.
   * False while a save of ours is pending; that save merges the change itself.
   */
  receive(slug: string, content: string, version: Version): boolean
  /** The versions the open document and its notes were last read or saved at. */
  versions(): { doc: Version | null, annotations: Version | null }
  /**
   * Room for the host inside the editor: `header` is a strip under the
   * toolbar that stays put; `top` sits above the text and scrolls with it.
   * Created on first use.
   */
  slot(where: 'header' | 'top'): HTMLElement
  notify(notice: Notice): void
  annotations: {
    list(): Annotation[]
    open(id: string): void
    remove(id: string): void
    /** Notes changed elsewhere: merge them in, as `receive` does for text. */
    receive(annotations: Annotation[], version: Version): boolean
  }
  /** Suggested edits, as an agent proposes them. */
  edits: {
    locate(edit: EditProposal): { start: number, end: number } | null
    highlight(edit: EditProposal): void
    clearHighlight(): void
    apply(edit: EditProposal, slug?: string): 'applied' | 'conflict'
    /** Apply, then save; a failed save withdraws the edit. */
    accept(edit: EditProposal, slug?: string): Promise<EditOutcome>
  }
  /** An overlay over the page for a plugin to draw in; created on first use. */
  layer(name: string): HTMLElement
  /** Page-local rects for [start, end) in the document's text. */
  rects(start: number, end: number): DOMRect[]
  on<K extends keyof EditorEvents>(type: K, handler: (payload: EditorEvents[K]) => void): () => void
  /** Stop background work while hidden; the document and its state stay. */
  suspend(): void
  resume(): Promise<void>
  destroy(): void
}

type Local = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserStorage(pick: () => Storage): Local | null {
  try { return pick() } catch { return null }
}

export function createEditor(root: HTMLElement, options: EditorOptions): Editor {
  const prefix = options.storagePrefix ?? 'galley'
  const historyStore: HistoryStore | null = options.storage?.history !== undefined
    ? options.storage.history
    : browserStorage(() => window.sessionStorage)
  const localStore: Local | null = options.storage?.local !== undefined
    ? options.storage.local
    : browserStorage(() => window.localStorage)
  const lastOpenKey = `${prefix}-last`
  const historyKey = (slug: string) => `${prefix}-history:${slug}`
  const ask = async (message: string) => (options.confirm ? options.confirm(message) : window.confirm(message))
  const comments = options.comments !== false

  // ── The shell ─────────────────────────────────────────────────────

  root.classList.add('galley')
  root.dataset.galleyTheme = options.theme ?? 'dark'
  root.innerHTML = ''
  const bar = el('header', { class: 'galley-bar' })
  const barRight = el('div', { class: 'galley-bar-right' })
  const main = el('main', { class: 'galley-main' })
  const page = el('div', { class: 'galley-page' })
  const docEl = el('div', { class: 'galley-doc' })
  if (options.placeholder) docEl.dataset.placeholder = options.placeholder
  const marksLayer = el('div', { class: 'galley-layer galley-marks' })
  const highlightLayer = el('div', { class: 'galley-layer galley-highlights', 'aria-hidden': 'true' })
  const fileInput = el('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain', hidden: '' })
  page.append(docEl, highlightLayer, marksLayer)
  const status = createStatusLine()
  main.append(page, status.element)
  const notices = options.notify ? null : createNoticeStack()
  root.append(bar, main, fileInput)
  if (notices) root.append(notices.element)

  const events = new Emitter<EditorEvents>()
  const cleanups: (() => void)[] = []
  const listen = (target: EventTarget, type: string, handler: EventListener) => {
    target.addEventListener(type, handler)
    cleanups.push(() => target.removeEventListener(type, handler))
  }

  // ── State ─────────────────────────────────────────────────────────

  let active = true
  let destroyed = false
  let loadRequestId = 0
  let externalOpenRequestId = 0
  let initialization: Promise<void> | null = null
  let writer = false
  // The note created by the Comment press that opened the panel, if any.
  // Only this one may be discarded when the panel closes empty.
  let createdNoteId: string | null = null

  function notify(notice: Notice): void {
    if (options.notify) options.notify(notice)
    else notices!.show(notice)
    events.emit('notice', notice)
  }

  const session = new DocumentSession(options.store, {
    status: (state) => {
      status.setState(state)
      events.emit('status', { state })
    },
    notice: notify,
    documents: () => {
      renderPicker()
      events.emit('documents', { documents: session.docs })
    },
    rebased: (slug, ours, merged) => {
      if (slug !== session.slug) return
      // Typing that happened while the merged save was on its way stays on top of it.
      const current = surface.getText()
      const next = current === ours ? merged : merge3(ours, current, merged).text
      if (next !== current) applyExternal(next)
      if (next !== merged) session.scheduleSave(next)
    },
    notesRebased: () => {
      renderOverlay()
      refreshOpenNote()
      events.emit('annotations', { annotations: session.annotations })
    },
  }, { save: options.saveDelay ?? 500, annotations: 400 })
  const me = options.me ?? 'You'

  const surface = createSurface(docEl, {
    onChange: afterEdit,
    onSelectionChange: (focused) => (focused ? selection?.update() : selection?.hide()),
    onCommand: (command) => {
      if (command === 'save') void session.flush()
      else void create()
    },
    onNotice: (message) => notify({ source: 'save', level: 'attention', message }),
  })

  let wordsFrame = 0
  function updateWords(): void {
    if (wordsFrame) return
    wordsFrame = requestAnimationFrame(() => {
      wordsFrame = 0
      status.setWords(countWords(surface.getText()))
    })
  }

  function afterEdit(): void {
    session.scheduleSave(surface.getText())
    updateWords()
    renderOverlay()
    if (session.slug) events.emit('change', { slug: session.slug })
  }

  // ── Notes ─────────────────────────────────────────────────────────

  const notes = comments ? createNotePanel(page, docEl, () => renderOverlay()) : null
  let rendering = false

  // A note someone answered, or one an agent opened, is shown as a thread.
  function threadOf(a: Annotation): ThreadView | null {
    if (!a.author && !a.replies?.length) return null
    return { author: a.author ?? null, comment: a.comment, created_at: a.created_at, replies: a.replies ?? [], labels: a.labels ?? [], resolved: !!a.resolved, me }
  }

  function refreshOpenNote(): void {
    const id = notes?.current()
    const a = id ? session.annotations.find((x) => x.id === id) : null
    const thread = a ? threadOf(a) : null
    if (id && thread) notes!.update(id, thread)
  }

  // Text that arrives from elsewhere goes in without moving the writer: the
  // caret stays on its line, found again by its text when lines above it
  // moved, and the arrival is one step the writer can undo.
  function applyExternal(text: string): void {
    const caret = surface.isFocused() ? surface.caret() : null
    const caretLine = caret ? (surface.lines()[caret.line]?.textContent ?? '') : ''
    surface.history.record()
    surface.setText(text)
    if (caret) {
      const lines = text.split('\n')
      let target = caret.line
      if (lines[target] !== caretLine) {
        for (let d = 1; d < 60; d++) {
          if (lines[caret.line + d] === caretLine) { target = caret.line + d; break }
          if (caret.line - d >= 0 && lines[caret.line - d] === caretLine) { target = caret.line - d; break }
        }
      }
      surface.setCaret(Math.min(target, lines.length - 1), caret.offset)
    }
    updateWords()
    renderOverlay()
  }

  function renderOverlay(): void {
    // A redraw can move the note panel, whose move redraws; once is enough.
    if (rendering) return
    rendering = true
    try {
      if (comments) {
        renderAnnotationMarks({
          layer: marksLayer,
          page,
          surface,
          annotations: session.annotations,
          moved: () => session.scheduleAnnotationsSave(),
        })
      }
      events.emit('layout', {})
    } finally {
      rendering = false
    }
  }

  function addComment(passage: SelectedPassage): void {
    if (!session.slug || session.annotationsReadySlug !== session.slug) {
      notify({ source: 'annotations', level: 'error', message: 'Notes unavailable. Reopen the document to retry.' })
      return
    }
    // Commenting on a span that already has a note opens that note, rather
    // than stacking a second identical one over it.
    const existing = session.annotations.find((a) => sameRange(a.range, passage.range))
    window.getSelection()?.removeAllRanges()
    if (existing) { openNote(existing.id); return }
    const now = new Date().toISOString()
    const id = `ann-${randomId().replace(/-/g, '').slice(0, 10)}`
    session.annotations.push({ id, range: passage.range, snippet: passage.text, comment: '', created_at: now, updated_at: now })
    session.scheduleAnnotationsSave()
    renderOverlay()
    openNote(id)
    // Opened by its own creation, so closing it with nothing in it discards it.
    createdNoteId = id
    events.emit('annotations', { annotations: session.annotations })
  }

  function openNote(id: string): void {
    if (!notes || !session.slug) return
    const a = session.annotations.find((x) => x.id === id)
    if (!a) return
    const lines = surface.lines()
    if (!lines.length) return
    // A passage that can no longer be found keeps its note: the panel opens
    // at the line it was last seen on.
    const located = reAnchor(a, lines.map((line) => line.textContent || ''), session.annotations)
    const lineIdx = located ? located.end_line : a.range.start_line
    notes.open({
      id,
      line: lines[Math.max(0, Math.min(lineIdx, lines.length - 1))],
      range: located && located.start_line === located.end_line
        ? { start: located.start_offset, end: located.end_offset }
        : { start: 0, end: 0 },
      value: a.comment,
      orphaned: !located,
      thread: threadOf(a),
      onInput: (value) => {
        if (a.comment === value) return
        a.comment = value
        a.updated_at = new Date().toISOString()
        session.scheduleAnnotationsSave()
      },
      // The note is looked up again on every answer: a merge may have replaced it since it opened.
      onReply: (text) => {
        const note = session.annotations.find((x) => x.id === id)
        if (!note) return
        const now = new Date().toISOString()
        note.replies = [...(note.replies ?? []), { id: `rep-${randomId().replace(/-/g, '').slice(0, 10)}`, author: { name: me, kind: 'human' }, text, created_at: now }]
        note.updated_at = now
        session.scheduleAnnotationsSave()
        refreshOpenNote()
        events.emit('annotations', { annotations: session.annotations })
      },
      onResolve: (resolved) => {
        const note = session.annotations.find((x) => x.id === id)
        if (!note) return
        if (resolved) note.resolved = true
        else delete note.resolved
        note.updated_at = new Date().toISOString()
        session.scheduleAnnotationsSave()
        renderOverlay()
        refreshOpenNote()
        events.emit('annotations', { annotations: session.annotations })
      },
      onDelete: () => removeNote(id),
      onClose: (returnCaret) => noteClosed(id, returnCaret),
    })
  }

  function removeNote(id: string): void {
    session.annotations = session.annotations.filter((a) => a.id !== id)
    session.scheduleAnnotationsSave()
    if (notes?.current() === id) notes.close()
    renderOverlay()
    events.emit('annotations', { annotations: session.annotations })
  }

  // A note with nothing in it is the residue of a click; keeping it leaves
  // the text underlined and every later click opening an empty panel.
  // Discard it on close — but only the note this panel just created. A note
  // the writer did not make in this breath is never removed unasked.
  function noteClosed(id: string, returnCaret: boolean): void {
    const a = session.annotations.find((x) => x.id === id)
    if (a && id === createdNoteId && a.comment.trim() === '') {
      session.annotations = session.annotations.filter((x) => x.id !== id)
      session.scheduleAnnotationsSave()
      renderOverlay()
      events.emit('annotations', { annotations: session.annotations })
    }
    createdNoteId = null
    if (returnCaret && a) {
      const snap = surface.snapshot()
      const endLine = Math.max(0, Math.min(a.range.end_line, snap.lineStarts.length - 1))
      const end = Math.min(snap.text.length, snap.lineStarts[endLine] + a.range.end_offset)
      const range = surface.domRange(end, end, snap)
      if (range) {
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        surface.focus()
      }
    }
  }

  listen(marksLayer, 'click', (e) => {
    const id = (e.target as HTMLElement)?.dataset?.annotation
    if (!id) return
    e.stopPropagation()
    openNote(id)
  })

  // ── Selection actions ─────────────────────────────────────────────

  const selectionItems = (options.selectionActions ?? ['comment'])
    .filter((item) => item !== 'comment' || comments)
    .map((item): ClusterAction => {
      if (item === 'comment') return { id: 'comment', label: 'Comment', description: 'Add a note to the selected text. Anyone working on the document can answer it, and you can resolve it when it is settled.', icon: icons.comment, run: addComment }
      return {
        id: item.id,
        label: item.label,
        icon: item.icon,
        run: (passage) => {
          if (!session.slug) return
          Promise.resolve(item.run({ ...passage, slug: session.slug }, editor))
            .catch((error) => console.error(`[galley] selection action ${item.id} failed:`, error))
        },
      }
    })
  const selection = selectionItems.length
    ? createSelectionCluster({
        surface,
        column: page,
        viewport: () => {
          const top = Math.max(0, bar.getBoundingClientRect().bottom)
          const bottom = Math.min(window.innerHeight, main.getBoundingClientRect().bottom)
          return { top, bottom }
        },
        actions: selectionItems,
      })
    : null
  if (selection) root.append(selection.element)

  // ── Toolbar and picker ────────────────────────────────────────────

  const builtins: Record<BuiltinAction, EditorAction> = {
    writer: {
      id: 'writer',
      label: 'Writer mode',
      description: 'Hide everything but the page, to write without distraction. Press again to bring the rest back.',
      icon: icons.focusEnter,
      pressedIcon: icons.focusExit,
      keepInWriterMode: true,
      pressed: () => writer,
      run: () => setWriterMode(!writer),
    },
    new: { id: 'new', label: 'New document', description: 'Start a new, empty document in this list.', shortcut: '⌘N', icon: icons.plus, run: () => create() },
    import: { id: 'import', label: 'Import a Markdown file', description: 'Open a Markdown file from your computer as a new document.', icon: icons.import, run: () => fileInput.click() },
    copy: {
      id: 'copy',
      label: 'Copy the document',
      description: "Copy this document's text, as Markdown, to the clipboard.",
      icon: icons.copy,
      run: async (_editor, button) => { if (await copy()) confirmOn(button, icons.check) },
    },
    delete: { id: 'delete', label: 'Delete the document', description: 'Delete this document. You are asked before anything is removed.', icon: icons.trash, danger: true, run: () => remove() },
  }
  const actions = (options.toolbar ?? ['writer', 'new', 'import', 'copy', 'delete'])
    .map((item) => (typeof item === 'string' ? builtins[item] : item))
  // Made once the editor object exists, since actions receive it.
  let toolbar: Toolbar | null = null
  bar.append(barRight)

  const picker: DocPicker | null = options.picker === false ? null : createDocPicker({
    select: (slug) => { void loadDoc(slug) },
    opening: () => { if (session.docsError) void session.fetchDocs() },
  })
  if (picker) barRight.append(picker.element)

  function renderPicker(): void {
    picker?.render({ docs: session.docs, current: session.slug, loaded: session.docsLoaded, error: session.docsError })
  }

  listen(fileInput, 'change', () => {
    const file = fileInput.files?.[0]
    fileInput.value = '' // choosing the same file again still loads it
    if (file) void importFile(file)
  })

  // ── Undo history across reloads ───────────────────────────────────

  function persistHistory(): 'kept' | 'trimmed' | 'too-large' | 'unavailable' {
    const slug = session.slug
    if (!slug || slug === session.deletingSlug || !historyStore) return 'kept'
    try {
      const dropped = writeHistory(historyStore, historyKey(slug), { version: 1, ...surface.history.export() })
      if (dropped > 0) {
        console.warn(`[galley] history trimmed ${dropped} steps to fit the byte budget`)
        notify({ source: 'save', level: 'attention', message: historyNotice('trimmed') })
        return 'trimmed'
      }
      return 'kept'
    } catch (error) {
      const outcome = error instanceof HistoryTooLargeError ? 'too-large' : 'unavailable'
      console.error('[galley] history could not be preserved:', error)
      notify({ source: 'save', level: 'attention', message: historyNotice(outcome) })
      return outcome
    }
  }

  // ── Documents ─────────────────────────────────────────────────────

  // A save that will not succeed must not silently lock the editor: say
  // what happened and let the writer decide.
  async function flushBeforeLeaving(action: string): Promise<boolean> {
    if (await session.flush()) return true
    const leave = await ask(
      'This document could not be saved — it may have changed somewhere else since it was opened.\n\n'
      + `OK to ${action} anyway and lose the unsaved changes, or Cancel to stay here and copy your text out first.`,
    )
    if (!leave) {
      notify({ source: 'save', level: 'attention', message: 'Not saved — changed elsewhere' })
      return false
    }
    await session.discard()
    return true
  }

  async function loadDoc(slug: string): Promise<void> {
    const requestId = ++loadRequestId
    if (!(await flushBeforeLeaving('switch documents')) || requestId !== loadRequestId) return
    notes?.close()
    clearHighlight()
    try {
      const data = await session.read(slug)
      if (requestId !== loadRequestId || !active) return
      // The current document stays editable while the read is in flight;
      // drain once more so keystrokes made meanwhile are not stranded.
      if (!(await flushBeforeLeaving('switch documents')) || requestId !== loadRequestId) return
      // The document is saved here, so history preservation is best-effort:
      // losing undo steps must never trap navigation.
      const historyOutcome = persistHistory()
      session.open(data)
      surface.setEditable(!session.frozen)
      surface.setText(data.content)
      // History is per document: undo must never walk back into the
      // previous document's text and save it over this one.
      surface.history.reset()
      let restored: HistoryEntry | null = null
      if (historyStore) {
        try {
          const history = readHistory(historyStore, historyKey(data.slug), data.content)
          if (history) {
            surface.history.import(history)
            restored = history.current
          }
        } catch (error) {
          console.error('[galley] history could not be restored:', error)
        }
      }
      try { localStore?.setItem(lastOpenKey, data.slug) } catch { /* ignore */ }
      renderPicker()
      session.markSaved()
      status.setWords(countWords(data.content))
      // markSaved cleared the notice persistHistory just reported; the new
      // document inherits it so the loss stays visible.
      if (historyOutcome !== 'kept') notify({ source: 'save', level: 'attention', message: historyNotice(historyOutcome) })
      surface.focus()
      surface.placeCaretAtEnd()
      if (restored) surface.setCaret(restored.line, restored.offset)
      events.emit('open', { slug: data.slug })
      if (comments) {
        await session.loadAnnotations(data.slug)
        if (requestId !== loadRequestId || !active) return
        events.emit('annotations', { annotations: session.annotations })
      }
      renderOverlay()
    } catch (error) {
      console.error('[galley] opening the document failed:', error)
      if (requestId === loadRequestId) notify({ source: 'save', level: 'error', message: 'Could not open the document' })
    }
  }

  async function create(): Promise<void> {
    if (!(await flushBeforeLeaving('start a new document'))) return
    try {
      const slug = await session.create()
      void session.fetchDocs({ fresh: true })
      await loadDoc(slug)
    } catch (error) {
      console.error('[galley] creating a document failed:', error)
      notify({ source: 'documents', level: 'error', message: 'Could not create a document' })
    }
  }

  // Import a Markdown file as a new document: decode it as UTF-8, create a
  // blank document, and load the text into it. Line endings are the only
  // change; the ordinary autosave persists it.
  async function importFile(file: File): Promise<void> {
    let content: string
    try {
      if (file.size > IMPORT_MAX_BYTES) throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MiB. Choose a file smaller than 5 MiB.`)
      content = decodeMarkdownImport(await file.arrayBuffer())
    } catch (error) {
      const message = (error as Error).message
      notify({ source: 'save', level: 'error', message: `Not imported: ${message.startsWith(file.name) ? message : `${file.name}. ${message}`}` })
      return
    }
    if (!(await flushBeforeLeaving('import a file'))) return
    try {
      const slug = await session.create()
      void session.fetchDocs({ fresh: true })
      await loadDoc(slug)
      if (session.slug !== slug) return
      surface.setText(content)
      surface.history.reset()
      session.markSaved()
      afterEdit()
    } catch (error) {
      console.error('[galley] import failed:', error)
      notify({ source: 'save', level: 'error', message: 'Could not import the file' })
    }
  }

  // The whole document, as raw markdown. Falls back to a hidden textarea
  // where navigator.clipboard is unavailable (insecure origins, webviews).
  async function copy(): Promise<boolean> {
    const text = surface.getText()
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        return true
      }
      const ta = el('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch (error) {
      console.error('[galley] copy failed:', error)
      return false
    }
  }

  async function remove(): Promise<void> {
    const d = session.current()
    if (!d) return
    if (!(await ask(`Delete "${d.title || UNTITLED}"? This cannot be undone.`))) return
    session.deletingSlug = d.slug
    await session.discard()
    loadRequestId += 1
    try {
      await session.store.remove(d.slug)
    } catch (error) {
      console.error('[galley] delete failed:', error)
      notify({ source: 'documents', level: 'error', message: 'Could not delete the document' })
      session.deletingSlug = null
      if (session.slug === d.slug) {
        session.scheduleSave(surface.getText())
        session.scheduleAnnotationsSave()
      }
      return
    }
    // The deleted document must stop being an editable target before the
    // replacement's reads begin, or keystrokes in that gap could recreate it.
    try { historyStore?.removeItem(historyKey(d.slug)) } catch (error) {
      console.error('[galley] the deleted document\'s history could not be removed:', error)
    }
    notes?.close()
    session.forget(d.slug)
    surface.setEditable(false)
    surface.setText('')
    surface.history.reset()
    renderOverlay()
    renderPicker()
    void session.fetchDocs({ fresh: true })
    try { localStore?.removeItem(lastOpenKey) } catch { /* ignore */ }
    try {
      if (session.docs.length) await loadDoc(session.docs[0].slug)
      else await create()
    } finally {
      session.deletingSlug = null
      if (session.slug) {
        surface.setEditable(!session.frozen)
        surface.focus()
        surface.placeCaretAtEnd()
      }
    }
  }

  async function openInitial(): Promise<void> {
    const listing = session.fetchDocs()
    let target = options.open ?? null
    if (!target) {
      try { target = localStore?.getItem(lastOpenKey) ?? null } catch { /* ignore */ }
    }
    const initialRequest = loadRequestId + (target ? 1 : 0)
    // The remembered document has its own read; listing must not delay it.
    if (target) await loadDoc(target)
    if (!(await listing) || !active || session.slug || loadRequestId !== initialRequest) return
    target = session.docs[0]?.slug || null
    if (target) await loadDoc(target)
    else await create()
  }

  function startInitial(): Promise<void> {
    if (initialization) return initialization
    const loading = openInitial()
    initialization = loading
    return loading.finally(() => { if (initialization === loading) initialization = null })
  }

  // ── Edits ─────────────────────────────────────────────────────────

  function clearHighlight(): void {
    highlightLayer.innerHTML = ''
  }

  function highlightEdit(edit: EditProposal): void {
    clearHighlight()
    const snap = surface.snapshot()
    const found = findEditRange(snap.text, edit)
    if (!found) return // nothing to show; a conflict surfaces on accept
    // A pure insertion is zero-width: widen it one character to the left so
    // there is something to see.
    let start = found.start
    if (start === found.end && start > 0) start -= 1
    const range = surface.domRange(start, found.end, snap)
    if (range) drawHighlight(highlightLayer, page, range)
  }

  // Work at the source level — splice the markdown, then re-render — so
  // headings, lists and fences re-flow from the new text. The edit is
  // bound to the document it was proposed for; it never lands on whatever
  // happens to be open.
  function applyEditTo(edit: EditProposal, slug = session.slug ?? ''): 'applied' | 'conflict' {
    if (surface.frozen || !slug || session.slug !== slug) return 'conflict'
    const result = applyEdit(surface.getText(), edit)
    if (!result) return 'conflict'
    surface.history.record() // an accepted edit is one undoable step
    surface.setText(result.text)
    const target = surface.lines()[locateLine(surface.snapshot().lineStarts, result.start)]
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    afterEdit()
    return 'applied'
  }

  async function acceptEdit(edit: EditProposal, slug = session.slug ?? ''): Promise<EditOutcome> {
    if (applyEditTo(edit, slug) === 'conflict') return 'conflict'
    if (!(await session.flush())) {
      applyEditTo({ ...edit, old: edit.new, new: edit.old }, slug)
      notify({ source: 'save', level: 'error', message: 'The edit could not be saved, so it was withdrawn. Resolve the save and accept it again.' })
      return 'failed'
    }
    return 'applied'
  }

  // ── Modes and lifecycle ───────────────────────────────────────────

  function setWriterMode(on: boolean): void {
    if (writer === on) return
    writer = on
    root.classList.toggle('galley--writer', on)
    toolbar?.update()
    events.emit('writer-mode', { on })
    if (on) surface.focus()
  }

  function setFrozen(frozen: boolean): void {
    session.frozen = frozen
    surface.setFrozen(frozen)
    surface.setEditable(!frozen && !!session.slug)
  }

  function suspend(): void {
    if (!active) return
    active = false
    externalOpenRequestId++
    if (!session.slug) {
      loadRequestId++
      initialization = null
    }
    session.clearTimers()
    void session.flush()
    picker?.close()
    selection?.hide()
    setWriterMode(false)
  }

  async function resume(): Promise<void> {
    if (destroyed) return
    active = true
    // The editor owns unsaved text, selection and undo; coming back only
    // refreshes the picker. Reopening the same file would replace that state.
    if (session.slug) {
      void session.fetchDocs()
      requestAnimationFrame(() => { if (active) renderOverlay() })
      return
    }
    await startInitial()
  }

  listen(window, 'resize', () => {
    renderOverlay()
    notes?.layout()
  })
  // A bfcache entry can be evicted without a second pagehide, so persist on
  // every transition.
  listen(window, 'pagehide', () => {
    persistHistory()
    session.sendBeacons()
  })

  let markReady!: () => void
  const ready = new Promise<void>((resolve) => { markReady = resolve })

  const editor: Editor = {
    root,
    surface,
    page,
    ready,
    get slug() { return session.slug },
    documents: () => session.docs.slice(),
    text: () => surface.getText(),
    async open(slug) {
      const requestId = ++externalOpenRequestId
      if (requestId !== externalOpenRequestId || !active) return
      void session.fetchDocs({ fresh: true })
      await loadDoc(slug)
    },
    create,
    importFile,
    remove,
    copy,
    flush: () => session.flush(),
    hasUnsavedChanges: () => session.isDirty(),
    persistHistory,
    refresh: () => session.fetchDocs({ fresh: true }),
    writerMode: () => writer,
    setWriterMode,
    setFrozen,
    adopt(slug, content, version) {
      if (session.slug !== slug) return
      session.adopt(slug, version)
      surface.setText(content)
      surface.history.reset()
      session.markSaved()
      updateWords()
      renderOverlay()
    },
    receive(slug, content, version) {
      if (destroyed || session.slug !== slug || session.frozen) return false
      if (session.version(slug) === version) return true
      if (session.isDirty()) return false
      const base = session.base(slug) ?? content
      const current = surface.getText()
      const next = current === base ? content : merge3(base, current, content).text
      session.adopt(slug, version, content)
      if (next !== current) applyExternal(next)
      if (next !== content) session.scheduleSave(next)
      return true
    },
    versions() {
      const slug = session.slug
      return { doc: slug ? session.version(slug) ?? null : null, annotations: slug ? session.annotationsVersion(slug) ?? null : null }
    },
    slot(where) {
      const existing = root.querySelector<HTMLElement>(`.galley-slot[data-slot="${where}"]`)
      if (existing) return existing
      const slot = el('div', { class: 'galley-slot', 'data-slot': where })
      if (where === 'header') root.insertBefore(slot, main)
      else page.insertBefore(slot, docEl)
      return slot
    },
    notify,
    annotations: {
      list: () => session.annotations.slice(),
      open: openNote,
      remove: removeNote,
      receive(list, version) {
        const slug = session.slug
        if (!slug) return false
        if (session.annotationsVersion(slug) === version) return true
        if (!session.receiveAnnotations(slug, list, version)) return false
        renderOverlay()
        refreshOpenNote()
        events.emit('annotations', { annotations: session.annotations })
        return true
      },
    },
    edits: {
      locate: (edit) => findEditRange(surface.getText(), edit),
      highlight: highlightEdit,
      clearHighlight,
      apply: applyEditTo,
      accept: acceptEdit,
    },
    layer(name) {
      const existing = page.querySelector<HTMLElement>(`:scope > .galley-layer[data-layer="${CSS.escape(name)}"]`)
      if (existing) return existing
      const layer = el('div', { class: 'galley-layer', 'data-layer': name })
      page.insertBefore(layer, marksLayer)
      return layer
    },
    rects(start, end) {
      const range = surface.domRange(start, end)
      return range ? pageRects(page, range) : []
    },
    on: (type, handler) => events.on(type, handler),
    suspend,
    resume,
    destroy() {
      if (destroyed) return
      suspend()
      destroyed = true
      notes?.close()
      for (const cleanup of cleanups.splice(0)) cleanup()
      picker?.destroy()
      surface.destroy()
      events.clear()
      root.classList.remove('galley', 'galley--writer')
      root.innerHTML = ''
    },
  }

  toolbar = createToolbar(actions, editor)
  bar.prepend(toolbar.element)

  // Plugins start before the first document opens, so they see its events.
  for (const plugin of options.plugins ?? []) {
    try {
      const cleanup = plugin(editor)
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    } catch (error) {
      console.error('[galley] a plugin failed to start:', error)
    }
  }

  renderPicker()
  status.setState('idle')
  status.setWords(0)
  void startInitial().finally(markReady)
  return editor
}

function historyNotice(outcome: 'trimmed' | 'too-large' | 'unavailable'): string {
  switch (outcome) {
    case 'trimmed': return 'Older undo steps were dropped to fit browser storage'
    case 'too-large': return 'Undo history could not be preserved — the document is too large for browser storage'
    case 'unavailable': return 'Undo history could not be preserved — browser storage is unavailable'
  }
}

export type { AnnotationRange }
