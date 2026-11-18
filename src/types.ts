// The shapes every part of Galley agrees on: the store, the server, the
// editor and the host app. Nothing here touches the DOM or Node.

/** An opaque version tag. A store issues one with every read and write. */
export type Version = string

export interface DocSummary {
  /** The document's identity; on disk, its filename without `.md`. */
  slug: string
  /** The first non-empty line, as plain text. */
  title: string
  /** ISO timestamp of the last write. */
  updated_at: string
  /** Size in bytes. */
  size: number
}

export interface DocRead {
  slug: string
  content: string
  updated_at: string
  version: Version
}

/**
 * What a versioned write claims to replace. A store refuses a write whose
 * base is no longer current (a conflict), and ignores one this client has
 * already superseded with a later revision (stale).
 */
export interface WriteContext {
  clientId: string
  revision: number
  baseVersion: Version
}

export interface DocWriteResult extends DocSummary {
  version: Version
  /** Set when a newer write from the same client already landed. */
  stale?: true
}

/** A range in source coordinates: line index, and offset into that line's markdown. */
export interface AnnotationRange {
  start_line: number
  start_offset: number
  end_line: number
  end_offset: number
}

/** A note attached to a passage. The snippet re-finds the passage after edits. */
export interface Annotation {
  id: string
  range: AnnotationRange
  /** The passage's text when the note was made, markers included. */
  snippet: string
  comment: string
  created_at: string
  updated_at: string
  /** Kept on notes written by older Poise versions; Galley never sets it. */
  session_id?: string
}

export interface AnnotationsRead {
  annotations: Annotation[]
  version: Version
}

export interface AnnotationsWriteResult {
  version: Version
  stale?: true
}

/**
 * A suggested edit, as an agent proposes one: replace `old` with `new`, or,
 * with `old` empty, insert `new` right after `context_before`. The contexts
 * single out one occurrence when `old` appears more than once.
 */
export interface EditProposal {
  description?: string
  context_before?: string
  old: string
  new: string
  context_after?: string
}

export type EditOutcome = 'applied' | 'conflict' | 'failed'
