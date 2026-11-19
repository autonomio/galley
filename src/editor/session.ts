// The open document's persistence: which document is current, the versions
// its saves are based on, the two save queues (text and notes), debouncing,
// and unload beacons. No DOM: the editor feeds it text and renders what it
// reports, and tests drive it against a memory store.
import { isConflict } from '../core/errors.js'
import { merge3, mergeAnnotations } from '../core/merge.js'
import { createSerializedSaveQueue, type SerializedSaveQueue } from '../core/save-queue.js'
import { randomId } from '../core/slug.js'
import type { Annotation, AnnotationsWriteResult, DocRead, DocSummary, DocWriteResult, Version } from '../types.js'
import type { DocumentStore } from '../stores/types.js'

/** Where the open document's text stands. */
export type SaveState = 'idle' | 'editing' | 'saving' | 'saved' | 'unsaved'

/**
 * Something the writer should see. One notice per source at a time; an
 * empty message withdraws that source's notice.
 */
export interface Notice {
  source: 'save' | 'annotations' | 'documents' | 'action' | (string & {})
  message: string
  level?: 'attention' | 'error'
}

export interface SessionEvents {
  status(state: SaveState): void
  notice(notice: Notice): void
  /** The document list, or one of its entries, changed. */
  documents(): void
  /**
   * Someone else saved the open document first, and their change was merged
   * into ours: `ours` is what we tried to save, `merged` what is saved now.
   */
  rebased?(slug: string, ours: string, merged: string): void
  /** The open document's notes were merged with a change made elsewhere. */
  notesRebased?(slug: string): void
}

export interface SessionDelays {
  save: number
  annotations: number
}

interface DocumentSnapshot {
  baseVersion: Version
  /** The text `baseVersion` names: what this snapshot was edited from, for a merge. */
  baseContent: string
  slug: string
  content: string
  revision: number
}

interface AnnotationsSnapshot {
  slug: string
  /** The notes' version when this snapshot was taken; a merge happened since if it is no longer current. */
  baseVersion: Version | undefined
  annotationsJson: string
  /** The notes as last read or saved, for a merge. */
  baseJson: string
  revision: number
}

export class DocumentSession {
  readonly clientId = randomId()
  slug: string | null = null
  docs: DocSummary[] = []
  docsLoaded = false
  docsError = false
  annotations: Annotation[] = []
  /** The document whose notes were read successfully; until then they are read-only. */
  annotationsReadySlug: string | null = null
  /** A document being deleted must never be written again. */
  deletingSlug: string | null = null
  /** While frozen, nothing is saved: something else owns the text. */
  frozen = false

  private readonly docVersions = new Map<string, Version>()
  private readonly annotationVersions = new Map<string, Version>()
  // The text and notes each version names, so a save refused because someone
  // else wrote first can merge both changes instead of failing.
  private readonly docBases = new Map<string, string>()
  private readonly annotationBases = new Map<string, string>()
  private docRevision = 0
  private annotationsRevision = 0
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private annotationsTimer: ReturnType<typeof setTimeout> | null = null
  private docsRead: Promise<boolean> | null = null
  private docsGeneration = 0
  private readonly documentQueue: SerializedSaveQueue<DocumentSnapshot>
  private readonly annotationsQueue: SerializedSaveQueue<AnnotationsSnapshot>

  constructor(
    readonly store: DocumentStore,
    private readonly events: SessionEvents,
    private readonly delays: SessionDelays = { save: 500, annotations: 400 },
  ) {
    this.documentQueue = createSerializedSaveQueue(
      (snapshot) => this.persistDocument(snapshot),
      (error) => {
        console.error('[galley] save failed:', error)
        this.events.status('unsaved')
        this.events.notice(isConflict(error)
          ? { source: 'save', level: 'attention', message: 'Not saved: this document changed somewhere else. Reload it to continue.' }
          : { source: 'save', level: 'error', message: `Not saved: ${messageOf(error)}` })
      },
    )
    this.annotationsQueue = createSerializedSaveQueue(
      (snapshot) => this.persistAnnotations(snapshot),
      (error) => {
        console.error('[galley] saving notes failed:', error)
        this.events.notice(isConflict(error)
          ? { source: 'annotations', level: 'attention', message: 'Notes not saved: they changed somewhere else. Reload to continue.' }
          : { source: 'annotations', level: 'error', message: `Notes not saved: ${messageOf(error)}` })
      },
    )
  }

  // ── The document list ─────────────────────────────────────────────

  current(): DocSummary | null {
    return this.slug ? this.docs.find((d) => d.slug === this.slug) ?? null : null
  }

  fetchDocs({ fresh = false }: { fresh?: boolean } = {}): Promise<boolean> {
    if (this.docsRead && !fresh) return this.docsRead
    const generation = ++this.docsGeneration
    this.docsError = false
    const pending: Promise<boolean> = this.readDocs(generation).finally(() => {
      if (this.docsRead === pending) this.docsRead = null
      if (generation === this.docsGeneration) this.events.documents()
    })
    this.docsRead = pending
    return pending
  }

  private async readDocs(generation: number): Promise<boolean> {
    try {
      const docs = await this.store.list()
      if (generation !== this.docsGeneration) return false
      if (!Array.isArray(docs)) throw new Error('Malformed document list')
      this.docs = docs
      this.docsLoaded = true
      this.events.notice({ source: 'documents', message: '' })
      return true
    } catch (error) {
      if (generation !== this.docsGeneration) return false
      console.error('[galley] listing documents failed:', error)
      this.docsError = true
      this.events.notice({ source: 'documents', level: 'error', message: `Documents unavailable: ${messageOf(error)}` })
      return false
    }
  }

  // ── Opening ───────────────────────────────────────────────────────

  async read(slug: string): Promise<DocRead> {
    const data = await this.store.read(slug)
    if (typeof data?.content !== 'string' || !isVersion(data.version)) throw new Error('Malformed document response')
    return { ...data, slug: String(data.slug || slug) }
  }

  /** Make `data` the current document. Its notes are unavailable until loadAnnotations. */
  open(data: DocRead): void {
    this.slug = data.slug
    this.docVersions.set(data.slug, data.version)
    this.docBases.set(data.slug, data.content)
    this.annotations = []
    this.annotationsReadySlug = null
  }

  /** The store changed the open document itself (an import from elsewhere). */
  adopt(slug: string, version: Version, content?: string): void {
    this.docVersions.set(slug, version)
    if (content !== undefined) this.docBases.set(slug, content)
  }

  /** The saved text the open document's edits are based on. */
  base(slug: string): string | undefined {
    return this.docBases.get(slug)
  }

  /** The version of the open document's notes, once read. */
  annotationsVersion(slug: string): Version | undefined {
    return this.annotationVersions.get(slug)
  }

  /**
   * Notes changed elsewhere arrive: merge them into ours and adopt their
   * version. False while a save of ours is pending; that save merges them.
   */
  receiveAnnotations(slug: string, theirs: Annotation[], version: Version): boolean {
    if (this.slug !== slug || this.annotationsReadySlug !== slug) return false
    if (this.annotationsQueue.isDirty() || this.annotationsTimer !== null) return false
    const base = JSON.parse(this.annotationBases.get(slug) ?? '[]') as Annotation[]
    const merged = mergeAnnotations(base, this.annotations, theirs).annotations
    const changedHere = JSON.stringify(merged) !== JSON.stringify(theirs)
    this.annotations = merged
    this.annotationVersions.set(slug, version)
    this.annotationBases.set(slug, JSON.stringify(theirs))
    if (changedHere) this.scheduleAnnotationsSave()
    return true
  }

  version(slug: string): Version | undefined {
    return this.docVersions.get(slug)
  }

  /** Forget a document that no longer exists. */
  forget(slug: string): void {
    this.docVersions.delete(slug)
    this.annotationVersions.delete(slug)
    this.docs = this.docs.filter((d) => d.slug !== slug)
    if (this.slug === slug) {
      this.slug = null
      this.annotations = []
      this.annotationsReadySlug = null
    }
  }

  async create(): Promise<string> {
    const result = await this.store.create()
    const slug = String(result?.slug || '')
    if (!slug) throw new Error('The store did not name the new document')
    return slug
  }

  // ── Saving the text ───────────────────────────────────────────────

  scheduleSave(content: string): void {
    const slug = this.slug
    if (!slug || slug === this.deletingSlug || this.frozen) return
    const baseVersion = this.docVersions.get(slug)
    if (!isVersion(baseVersion)) {
      this.events.notice({ source: 'save', level: 'error', message: 'Not saved: the document version is unavailable. Reload it before editing.' })
      return
    }
    this.documentQueue.enqueue({ baseVersion, baseContent: this.docBases.get(slug) ?? content, slug, content, revision: ++this.docRevision })
    this.events.status('editing')
    this.clearSaveTimer()
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flushSave()
    }, this.delays.save)
  }

  /** The text is saved and the notice for saving is clear. */
  markSaved(): void {
    this.events.status('saved')
    this.events.notice({ source: 'save', message: '' })
  }

  private async flushSave(): Promise<boolean> {
    this.clearSaveTimer()
    const ok = await this.documentQueue.flush()
    if (ok && !this.documentQueue.isDirty() && this.slug) this.markSaved()
    return ok
  }

  private async persistDocument(snapshot: DocumentSnapshot): Promise<void> {
    if (this.slug === snapshot.slug) this.events.status('saving')
    let content = snapshot.content
    let merged: { text: string, conflicts: number } | null = null
    let result: DocWriteResult
    try {
      result = await this.store.write(snapshot.slug, content, {
        clientId: this.clientId,
        revision: snapshot.revision,
        baseVersion: snapshot.baseVersion,
      })
    } catch (error) {
      if (!isConflict(error)) throw error
      // Someone else saved first: an agent writing from a paper run, or another
      // tab. Their change and ours merge line by line; where both touched the
      // same lines, ours stand. The refused write was never recorded, so the
      // merge goes out under the same revision.
      const remote = await this.store.read(snapshot.slug)
      merged = merge3(snapshot.baseContent, snapshot.content, remote.content)
      content = merged.text
      result = await this.store.write(snapshot.slug, content, {
        clientId: this.clientId,
        revision: snapshot.revision,
        baseVersion: remote.version,
      })
    }
    if (!isVersion(result?.version)) throw new Error('save response omitted document version')
    // A stale acknowledgement may describe a version written later by another
    // tab. Advancing our base from it would let unchanged local text
    // overwrite the other tab on its next edit; same-client continuation is
    // tracked by the store, so stale responses never advance the base.
    if (result.stale === true) return
    this.docVersions.set(snapshot.slug, result.version)
    this.docBases.set(snapshot.slug, content)
    if (merged) {
      if (this.slug === snapshot.slug) this.events.rebased?.(snapshot.slug, snapshot.content, content)
      // A notice of its own: the save that follows would clear a save notice at once.
      if (merged.conflicts) this.events.notice({ source: 'merge', level: 'attention', message: 'Merged with a change made elsewhere. Where you both changed the same lines, your version stands.' })
    }
    // Only a listed document moves to the top; one not listed yet arrives
    // with the next listing, and one just deleted must not come back.
    const idx = this.docs.findIndex((d) => d.slug === snapshot.slug)
    if (idx >= 0) {
      const [entry] = this.docs.splice(idx, 1)
      this.docs.unshift({
        slug: snapshot.slug,
        title: String(result.title || entry.title),
        updated_at: String(result.updated_at || new Date().toISOString()),
        size: Number(result.size || content.length),
      })
    }
    this.events.documents()
  }

  // ── Saving the notes ──────────────────────────────────────────────
  //
  // Notes are a side-car list next to the document, fetched with it and
  // saved through their own debounced queue.

  async loadAnnotations(slug: string): Promise<void> {
    if (this.slug === slug) {
      this.annotations = []
      this.annotationsReadySlug = null
    }
    try {
      const data = await this.store.readAnnotations(slug)
      if (this.slug !== slug) return
      if (!Array.isArray(data?.annotations) || !isVersion(data.version)) throw new Error('malformed annotations response')
      this.annotations = data.annotations
      this.annotationVersions.set(slug, data.version)
      this.annotationBases.set(slug, JSON.stringify(data.annotations))
      this.annotationsReadySlug = slug
      this.events.notice({ source: 'annotations', message: '' })
    } catch (error) {
      console.error('[galley] reading notes failed:', error)
      if (this.slug === slug) this.events.notice({ source: 'annotations', level: 'error', message: 'Notes unavailable. Reopen the document to retry.' })
    }
  }

  scheduleAnnotationsSave(): void {
    const slug = this.slug
    if (!slug || slug === this.deletingSlug) return
    // Never turn a transient or corrupt read into a destructive replacement
    // with an empty in-memory list. Reopening the document retries the read.
    if (this.annotationsReadySlug !== slug) {
      console.error('[galley] notes are read-only until they load')
      this.events.notice({ source: 'annotations', level: 'error', message: 'Notes unavailable. Reopen the document to retry.' })
      return
    }
    this.annotationsQueue.enqueue({
      slug,
      baseVersion: this.annotationVersions.get(slug),
      annotationsJson: JSON.stringify(this.annotations),
      baseJson: this.annotationBases.get(slug) ?? '[]',
      revision: ++this.annotationsRevision,
    })
    this.clearAnnotationsTimer()
    this.annotationsTimer = setTimeout(() => {
      this.annotationsTimer = null
      void this.flushAnnotations()
    }, this.delays.annotations)
  }

  private flushAnnotations(): Promise<boolean> {
    this.clearAnnotationsTimer()
    return this.annotationsQueue.flush()
  }

  private async persistAnnotations(snapshot: AnnotationsSnapshot): Promise<void> {
    if (!isVersion(snapshot.baseVersion)) throw new Error('the notes version is unavailable; reload before saving')
    let json = snapshot.annotationsJson
    let result: AnnotationsWriteResult
    try {
      result = await this.store.writeAnnotations(snapshot.slug, JSON.parse(json) as Annotation[], {
        clientId: this.clientId,
        revision: snapshot.revision,
        baseVersion: snapshot.baseVersion,
      })
    } catch (error) {
      if (!isConflict(error)) throw error
      // Notes changed elsewhere since we read them (an agent answered a thread,
      // or another tab wrote): merge by note, and by reply within a thread.
      const remote = await this.store.readAnnotations(snapshot.slug)
      const merged = mergeAnnotations(JSON.parse(snapshot.baseJson) as Annotation[], JSON.parse(json) as Annotation[], remote.annotations).annotations
      json = JSON.stringify(merged)
      result = await this.store.writeAnnotations(snapshot.slug, merged, {
        clientId: this.clientId,
        revision: snapshot.revision,
        baseVersion: remote.version,
      })
      if (isVersion(result?.version) && result.stale !== true && this.slug === snapshot.slug) {
        // Edits made while the merge was on its way stay on top of it.
        this.annotations = mergeAnnotations(JSON.parse(snapshot.annotationsJson) as Annotation[], this.annotations, merged).annotations
        this.annotationVersions.set(snapshot.slug, result.version)
        this.annotationBases.set(snapshot.slug, json)
        this.events.notesRebased?.(snapshot.slug)
      }
    }
    if (!isVersion(result?.version)) throw new Error('save response omitted annotations version')
    if (result.stale !== true) {
      this.annotationVersions.set(snapshot.slug, result.version)
      this.annotationBases.set(snapshot.slug, json)
    }
    this.events.notice({ source: 'annotations', message: '' })
  }

  // ── Both together ─────────────────────────────────────────────────

  /** Save everything pending. False when something could not be saved. */
  async flush(): Promise<boolean> {
    for (;;) {
      const [docSaved, annotationsSaved] = await Promise.all([this.flushSave(), this.flushAnnotations()])
      if (!docSaved || !annotationsSaved) return false
      if (!this.documentQueue.isDirty() && !this.annotationsQueue.isDirty()) return true
    }
  }

  /** Drop everything pending, unsaved. */
  async discard(): Promise<void> {
    this.clearTimers()
    await Promise.all([this.documentQueue.discard(), this.annotationsQueue.discard()])
  }

  /** Whether leaving now could lose something. */
  isDirty(): boolean {
    return this.documentQueue.isDirty() || this.annotationsQueue.isDirty()
      || this.saveTimer !== null || this.annotationsTimer !== null || this.deletingSlug !== null
  }

  clearTimers(): void {
    this.clearSaveTimer()
    this.clearAnnotationsTimer()
  }

  /**
   * Hand pending saves to the store's beacon while the page unloads. Only
   * dirty, immutable snapshots are sent; per-client revisions make that
   * safe even when an older request is still in flight.
   */
  sendBeacons(): void {
    this.clearTimers()
    const beacon = this.store.beacon?.bind(this.store)
    if (!beacon) return
    const doc = this.documentQueue.pending()
    if (doc) {
      const context = { clientId: this.clientId, revision: doc.revision, baseVersion: doc.baseVersion }
      if (!beacon({ kind: 'document', slug: doc.slug, content: doc.content, context })) {
        console.warn('[galley] the document unload save was not queued')
      }
    }
    const notes = this.annotationsQueue.pending()
    const notesBase = notes ? this.annotationVersions.get(notes.slug) : undefined
    if (notes && isVersion(notesBase)) {
      const context = { clientId: this.clientId, revision: notes.revision, baseVersion: notesBase }
      const annotations = JSON.parse(notes.annotationsJson) as Annotation[]
      if (!beacon({ kind: 'annotations', slug: notes.slug, annotations, context })) {
        console.warn('[galley] the notes unload save was not queued')
      }
    }
  }

  private clearSaveTimer(): void {
    if (this.saveTimer === null) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
  }

  private clearAnnotationsTimer(): void {
    if (this.annotationsTimer === null) return
    clearTimeout(this.annotationsTimer)
    this.annotationsTimer = null
  }
}

function isVersion(value: unknown): value is Version {
  return typeof value === 'string' && value.length > 0
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}
