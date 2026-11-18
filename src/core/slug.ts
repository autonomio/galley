import { InvalidSlugError } from './errors.js'

// A public slug and its on-disk basename must be a bijection. Rejecting rather
// than sanitizing is important: "a b", "a_b", and overlong common prefixes
// must never address the same document.
export const MAX_SLUG_LENGTH = 120
const CANONICAL_SLUG_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/

export function isCanonicalSlug(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_SLUG_LENGTH
    && CANONICAL_SLUG_RE.test(value)
}

export function canonicalSlug(value: unknown): string {
  if (!isCanonicalSlug(value)) throw new InvalidSlugError()
  return value
}

export function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

// Mint a fresh, sortable slug for a new blank doc. Millisecond time keeps
// creation order legible; a random id prevents collisions across
// simultaneous requests and processes.
export function newSlug(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[^0-9]/g, '')
  return `untitled-${stamp}-${randomId()}`
}
