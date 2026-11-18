import type { Version } from '../types.js'

/** The thing being written changed since the writer last read it. */
export class ConflictError extends Error {
  readonly code = 'GALLEY_CONFLICT'
  readonly statusCode = 409

  constructor(readonly currentVersion: Version, message = 'editor content changed since it was loaded') {
    super(message)
    this.name = 'ConflictError'
  }
}

/** A request named a document in a form no store accepts. */
export class InvalidSlugError extends Error {
  readonly code = 'GALLEY_INVALID_SLUG'
  readonly statusCode = 400

  constructor() {
    super('invalid slug')
    this.name = 'InvalidSlugError'
  }
}

export function isConflict(error: unknown): error is ConflictError {
  return error instanceof ConflictError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'GALLEY_CONFLICT')
}
