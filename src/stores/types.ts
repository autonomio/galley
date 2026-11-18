import type {
  Annotation,
  AnnotationsRead,
  AnnotationsWriteResult,
  DocRead,
  DocSummary,
  DocWriteResult,
  WriteContext,
} from '../types.js'

/**
 * Where documents live. The editor never touches storage any other way, so a
 * host adopts Galley by handing it one of these: the HTTP store for Galley's
 * server (or anything speaking its protocol), the memory or local store for
 * no backend at all, or its own.
 *
 * Contract, which tests/unit/store-contract.test.ts checks for every store
 * shipped here:
 *   - `write` with a context refuses with a ConflictError when the base is
 *     no longer current, and returns `stale: true` (writing nothing) when the
 *     same client already wrote a newer revision. See core/write-guard.ts.
 *   - `read` of a missing document rejects.
 *   - `readAnnotations` of a document without notes resolves to an empty
 *     list and a version that a first write may be based on.
 *   - `remove` takes the document's notes with it.
 */
export interface DocumentStore {
  list(): Promise<DocSummary[]>
  /** Make a new blank document. */
  create(): Promise<DocWriteResult>
  read(slug: string): Promise<DocRead>
  write(slug: string, content: string, context: WriteContext): Promise<DocWriteResult>
  remove(slug: string): Promise<void>
  readAnnotations(slug: string): Promise<AnnotationsRead>
  writeAnnotations(slug: string, annotations: Annotation[], context: WriteContext): Promise<AnnotationsWriteResult>
  /**
   * Hand off a pending save while the page unloads, synchronously. Returns
   * whether it was accepted. Optional: a store without it relies on the
   * last debounced save having landed.
   */
  beacon?(save: UnloadSave): boolean
}

export type UnloadSave =
  | { kind: 'document', slug: string, content: string, context: WriteContext }
  | { kind: 'annotations', slug: string, annotations: Annotation[], context: WriteContext }
