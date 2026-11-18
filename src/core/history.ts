// Undo history that survives a reload, kept per document and per tab.
//
// The editor keeps whole-document snapshots (see src/surface/history.ts for
// why the browser's own undo stack cannot be used). This module bounds them
// and persists them to a Storage-like object, normally sessionStorage, so a
// reload keeps the timeline without sharing undo between tabs.
export interface HistoryEntry {
  text: string
  line: number
  offset: number
}

export interface HistorySnapshot {
  version: 1
  current: HistoryEntry
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

export const HISTORY_LIMIT = 300

// One document's timeline may not exceed this many serialized characters,
// in memory or in storage. Browsers count sessionStorage quota in UTF-16
// code units at roughly 5 MiB per origin, shared with everything else the
// host keeps there; 1 MiB per document keeps several large timelines clear
// of QuotaExceededError while typical few-KB documents keep hundreds of
// steps. A document whose current text alone exceeds the budget keeps no
// persisted timeline at all.
export const HISTORY_BYTE_BUDGET = 1_048_576

/** Nothing about this document's timeline can ever be persisted. Waiting cannot help. */
export class HistoryTooLargeError extends Error {
  constructor(readonly key: string, readonly bytes: number) {
    super(`Undo history "${key}" exceeds its ${HISTORY_BYTE_BUDGET}-byte budget (${bytes} bytes for the current entry alone)`)
    this.name = 'HistoryTooLargeError'
  }
}

export type HistoryStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function isEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.text === 'string'
    && Number.isSafeInteger(entry.line) && (entry.line as number) >= 0
    && Number.isSafeInteger(entry.offset) && (entry.offset as number) >= 0
}

function isStack(value: unknown): value is HistoryEntry[] {
  return Array.isArray(value) && value.length <= HISTORY_LIMIT && value.every(isEntry)
}

// +1 covers the comma joining entries; the surrounding brackets are
// counted in the snapshot overhead, so the accounted total always
// covers the serialized form and the fit below is guaranteed.
function serializedEntrySize(entry: HistoryEntry): number {
  return JSON.stringify(entry).length + 1
}

/**
 * Drop the oldest entries in place until the stacks fit `budget`
 * serialized characters. Undo goes first so the immediate redo chain
 * survives longest. Returns the number of dropped entries.
 */
export function trimHistoryStacks(undo: HistoryEntry[], redo: HistoryEntry[], budget: number): number {
  let bytes = 0
  for (const entry of undo) bytes += serializedEntrySize(entry)
  for (const entry of redo) bytes += serializedEntrySize(entry)
  let dropped = 0
  while (bytes > budget) {
    const entry = undo.length ? undo.shift() : redo.shift()
    if (!entry) break
    bytes -= serializedEntrySize(entry)
    dropped++
  }
  return dropped
}

/** The persisted timeline for `key`, if it still belongs to `text`. */
export function readHistory(store: HistoryStore, key: string, text: string): HistorySnapshot | null {
  const raw = store.getItem(key)
  if (!raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { value = null }
  if (value && typeof value === 'object') {
    const snapshot = value as Record<string, unknown>
    if (snapshot.version === 1 && isEntry(snapshot.current) && snapshot.current.text === text
        && isStack(snapshot.undo) && isStack(snapshot.redo)) {
      return { version: 1, current: snapshot.current, undo: snapshot.undo, redo: snapshot.redo }
    }
  }
  // An external edit invalidates the timeline; never revive it on a later load.
  store.removeItem(key)
  return null
}

/**
 * Persist the timeline trimmed to HISTORY_BYTE_BUDGET; returns how many
 * entries were dropped to fit. Throws HistoryTooLargeError when the
 * current entry alone exceeds the budget, and rethrows storage failures.
 */
export function writeHistory(store: HistoryStore, key: string, snapshot: HistorySnapshot): number {
  const overhead = JSON.stringify({ version: 1, current: snapshot.current, undo: [], redo: [] }).length
  if (overhead > HISTORY_BYTE_BUDGET) {
    // Checked before the empty-stacks fast path: live trimming may have
    // already removed every step, but an oversized document still cannot
    // keep a timeline, and the caller must report that instead of 'kept'.
    // A stale timeline for this document must not linger and spend quota.
    try { store.removeItem(key) } catch { /* the budget error below carries the failure */ }
    throw new HistoryTooLargeError(key, overhead)
  }
  if (!snapshot.undo.length && !snapshot.redo.length) {
    store.removeItem(key)
    return 0
  }
  const undo = snapshot.undo.slice()
  const redo = snapshot.redo.slice()
  const dropped = trimHistoryStacks(undo, redo, HISTORY_BYTE_BUDGET - overhead)
  if (!undo.length && !redo.length) {
    store.removeItem(key)
    return dropped
  }
  const raw = JSON.stringify({ version: 1, current: snapshot.current, undo, redo })
  store.setItem(key, raw)
  if (store.getItem(key) !== raw) throw new Error('Undo history storage did not retain the complete snapshot')
  return dropped
}
