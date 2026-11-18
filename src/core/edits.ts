import type { EditProposal } from '../types.js'

/**
 * Locate an edit's target in the document as a character range. Null when
 * `old` is not there, or is there more than once and the contexts cannot
 * single one out. A pure insertion (`old` empty) is a zero-width range right
 * after `context_before`; it is never placed blind.
 */
export function findEditRange(text: string, edit: EditProposal): { start: number, end: number } | null {
  const before = edit.context_before || ''
  const after = edit.context_after || ''
  if (edit.old === '') {
    if (!before) return null // pure insertion with no anchor is unsafe
    const occurrences = allOccurrences(text, before)
    if (occurrences.length === 0) return null
    if (occurrences.length === 1) {
      const pos = occurrences[0] + before.length
      return { start: pos, end: pos }
    }
    for (const idx of occurrences) {
      const followStart = idx + before.length
      const follow = text.slice(followStart, followStart + after.length)
      if (after && follow === after) return { start: followStart, end: followStart }
    }
    return null
  }
  const occurrences = allOccurrences(text, edit.old)
  if (occurrences.length === 0) return null
  if (occurrences.length === 1) {
    return { start: occurrences[0], end: occurrences[0] + edit.old.length }
  }
  // Multiple matches — refuse to guess. At least one context anchor must be
  // supplied and must positively single out an occurrence; otherwise it is
  // a conflict and the agent can be asked for more context.
  if (!before && !after) return null
  for (const idx of occurrences) {
    const left = text.slice(Math.max(0, idx - before.length), idx)
    const right = text.slice(idx + edit.old.length, idx + edit.old.length + after.length)
    if ((!before || left === before) && (!after || right === after)) {
      return { start: idx, end: idx + edit.old.length }
    }
  }
  return null
}

export function allOccurrences(text: string, needle: string): number[] {
  if (!needle) return []
  const out: number[] = []
  for (let idx = text.indexOf(needle); idx >= 0; idx = text.indexOf(needle, idx + 1)) out.push(idx)
  return out
}

/** The edit applied to `text`, or null when it cannot be located. */
export function applyEdit(text: string, edit: EditProposal): { text: string, start: number } | null {
  const range = findEditRange(text, edit)
  if (!range) return null
  return { text: text.slice(0, range.start) + edit.new + text.slice(range.end), start: range.start }
}
