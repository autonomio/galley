// Stores with no backend. The memory store keeps documents for the life of
// the page (tests, demos, a host that persists elsewhere); the local store
// is the same store written through to localStorage, so an app can adopt
// Galley with no server at all. Both apply the same write rules as the
// file store (core/write-guard.ts).
import { ConflictError } from '../core/errors.js'
import { canonicalSlug, newSlug, randomId } from '../core/slug.js'
import { WriteGuard, validWriteContext } from '../core/write-guard.js'
import { deriveTitle } from '../markdown/title.js'
import type { Annotation, DocSummary, DocWriteResult, Version, WriteContext } from '../types.js'
import type { DocumentStore, UnloadSave } from './types.js'

const MISSING_DOC = 'missing-document'
const MISSING_ANNOTATIONS = 'missing-annotations'
export const MAX_DOC_BYTES = 5 * 1024 * 1024

interface StoredDoc { content: string, updated_at: string, version: Version }
interface StoredNotes { annotations: Annotation[], version: Version }

export interface MemoryState {
  docs: Record<string, StoredDoc>
  annotations: Record<string, StoredNotes>
}

export interface MemoryStoreOptions {
  /** Documents to start with, by slug. */
  documents?: Record<string, string>
  /** Called with the whole state after every change. */
  persist?: (state: MemoryState) => void
  /** State to start from, as `persist` last saw it. */
  state?: MemoryState
  now?: () => Date
}

const encoder = new TextEncoder()
const byteLength = (s: string) => encoder.encode(s).byteLength
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function createMemoryStore(options: MemoryStoreOptions = {}): DocumentStore & { state(): MemoryState } {
  const now = options.now ?? (() => new Date())
  const docs = new Map<string, StoredDoc>(Object.entries(options.state?.docs ?? {}))
  const notes = new Map<string, StoredNotes>(Object.entries(options.state?.annotations ?? {}))
  for (const [slug, content] of Object.entries(options.documents ?? {})) {
    if (!docs.has(canonicalSlug(slug))) docs.set(slug, { content, updated_at: now().toISOString(), version: randomId() })
  }
  const guard = new WriteGuard()

  const state = (): MemoryState => ({ docs: Object.fromEntries(docs), annotations: Object.fromEntries(notes) })
  const persist = () => options.persist?.(state())

  function summary(slug: string, doc: StoredDoc): DocSummary {
    return { slug, title: deriveTitle(doc.content), updated_at: doc.updated_at, size: byteLength(doc.content) }
  }

  function writeDoc(slug: string, content: string, context?: WriteContext): DocWriteResult {
    canonicalSlug(slug)
    if (typeof content !== 'string') throw new Error('content must be a string')
    if (byteLength(content) > MAX_DOC_BYTES) throw new Error(`doc too large (max ${MAX_DOC_BYTES} bytes)`)
    const valid = context ? validWriteContext(context) : null
    const current = docs.get(slug)
    if (valid) {
      if (!current) throw new ConflictError(MISSING_DOC)
      if (guard.admit(`doc:${slug}`, valid, current.version) === 'stale') {
        return { ...summary(slug, current), version: current.version, stale: true }
      }
    }
    // Same content keeps its version, the way a content hash would.
    const version = current && current.content === content ? current.version : randomId()
    const stored = { content, updated_at: now().toISOString(), version }
    docs.set(slug, stored)
    if (valid) guard.remember(`doc:${slug}`, valid, version)
    persist()
    return { ...summary(slug, stored), version }
  }

  function writeNotes(slug: string, annotations: Annotation[], context?: WriteContext): { version: Version, stale?: true } {
    canonicalSlug(slug)
    if (!Array.isArray(annotations)) throw new Error('annotations must be an array')
    const valid = context ? validWriteContext(context) : null
    const current = notes.get(slug)
    if (valid && guard.admit(`notes:${slug}`, valid, current?.version ?? MISSING_ANNOTATIONS) === 'stale') {
      return { version: current?.version ?? MISSING_ANNOTATIONS, stale: true }
    }
    const version = randomId()
    notes.set(slug, { annotations: clone(annotations), version })
    if (valid) guard.remember(`notes:${slug}`, valid, version)
    persist()
    return { version }
  }

  return {
    state,
    async list() {
      return [...docs.entries()]
        .map(([slug, doc]) => summary(slug, doc))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    },
    async create() {
      return writeDoc(newSlug(now()), '')
    },
    async read(slug) {
      const doc = docs.get(canonicalSlug(slug))
      if (!doc) throw Object.assign(new Error('not found'), { status: 404 })
      return { slug, content: doc.content, updated_at: doc.updated_at, version: doc.version }
    },
    async write(slug, content, context) {
      return writeDoc(slug, content, context)
    },
    async remove(slug) {
      canonicalSlug(slug)
      docs.delete(slug)
      notes.delete(slug)
      guard.forget(`doc:${slug}`)
      guard.forget(`notes:${slug}`)
      persist()
    },
    async readAnnotations(slug) {
      const current = notes.get(canonicalSlug(slug))
      return current
        ? { annotations: clone(current.annotations), version: current.version }
        : { annotations: [], version: MISSING_ANNOTATIONS }
    },
    async writeAnnotations(slug, annotations, context) {
      return writeNotes(slug, annotations, context)
    },
    // Memory writes are synchronous, so an unload save simply lands.
    beacon(save: UnloadSave): boolean {
      try {
        if (save.kind === 'document') writeDoc(save.slug, save.content, save.context)
        else writeNotes(save.slug, save.annotations, save.context)
        return true
      } catch {
        return false
      }
    },
  }
}

export interface LocalStoreOptions {
  /** The localStorage key holding every document. Default `galley:documents`. */
  key?: string
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  /** Documents to start with when nothing is stored yet. */
  documents?: Record<string, string>
}

/** The memory store, written through to localStorage. Fine for a few megabytes of text. */
export function createLocalStore(options: LocalStoreOptions = {}): DocumentStore {
  const key = options.key ?? 'galley:documents'
  const storage = options.storage ?? window.localStorage
  let state: MemoryState | undefined
  try {
    const raw = storage.getItem(key)
    if (raw) state = JSON.parse(raw) as MemoryState
  } catch (error) {
    console.error('[galley] stored documents could not be read:', error)
  }
  return createMemoryStore({
    state,
    documents: state ? undefined : options.documents,
    persist: (next) => storage.setItem(key, JSON.stringify(next)),
  })
}
