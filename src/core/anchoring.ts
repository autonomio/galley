// Keeping a note on its passage while the text around it changes.
//
// A note stores where its passage was (line + offset pairs) and what it
// said (the snippet). Every render checks the stored position first; if
// the text there no longer matches, the passage is searched for and the
// note moves with it. A passage that cannot be found leaves the note
// orphaned: it stays stored, so the writer's comment is never silently
// lost, and comes back if the text does.
import type { Annotation, AnnotationRange } from '../types.js'

// The text a range covers, its lines joined with '\n': the snippet an
// annotation records, and what re-anchoring compares it with. Null when
// the range does not fit the document's lines.
export function rangeText(lines: readonly string[], range: AnnotationRange): string | null {
  const first = lines[range.start_line]
  const last = lines[range.end_line]
  if (first === undefined || last === undefined || range.end_line < range.start_line) return null
  if (range.start_line === range.end_line) return first.slice(range.start_offset, range.end_offset)
  const parts = [first.slice(range.start_offset)]
  for (let i = range.start_line + 1; i < range.end_line; i++) parts.push(lines[i])
  parts.push(last.slice(0, range.end_offset))
  return parts.join('\n')
}

// Two annotations cover the same span when all four coordinates agree.
export function sameRange(a: AnnotationRange, b: AnnotationRange): boolean {
  return a.start_line === b.start_line && a.start_offset === b.start_offset
    && a.end_line === b.end_line && a.end_offset === b.end_offset
}

/**
 * Where the note's passage is now, or null when it cannot be found. The
 * recorded position wins while its text still matches; otherwise the
 * nearest free occurrence of the snippet does.
 */
export function reAnchor(a: Annotation, lines: readonly string[], all: readonly Annotation[]): AnnotationRange | null {
  if (!lines.length) return null
  if (rangeText(lines, a.range) === a.snippet) return a.range // fast path: still in place

  // Search outward from the line the annotation was last seen on, not from
  // the top of the document. Taking the first hit from line 0 moved a note
  // onto an entirely different passage whenever the document repeated a
  // phrase, and a second such note landed on the same words.
  // `home` is a remembered index, so it can point past the end after lines
  // are deleted. Clamp it into the document first: an out-of-range `home`
  // would cut the search short and orphan notes still in the document.
  const home = Math.max(0, Math.min(a.range.start_line, lines.length - 1))
  const order: number[] = []
  for (let d = 0; d < lines.length; d++) {
    const back = home - d
    const fwd = home + d
    if (back >= 0 && back < lines.length) order.push(back)
    if (d > 0 && fwd >= 0 && fwd < lines.length) order.push(fwd)
  }

  // One search for both shapes. Occurrences of the snippet in the joined
  // document bucket by the line they start on, already left to right; the
  // outward line order above then picks the nearest line, earliest on a
  // tie. Single-line and multi-line notes are found the same way.
  const starts: number[] = []
  let acc = 0
  for (const text of lines) { starts.push(acc); acc += text.length + 1 }
  const locate = (abs: number): { line: number, offset: number } => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= abs) lo = mid
      else hi = mid - 1
    }
    return { line: lo, offset: abs - starts[lo] }
  }
  const byLine = new Map<number, AnnotationRange[]>()
  const doc = lines.join('\n')
  if (a.snippet) {
    for (let idx = doc.indexOf(a.snippet); idx >= 0; idx = doc.indexOf(a.snippet, idx + 1)) {
      const s = locate(idx)
      const e = locate(idx + a.snippet.length)
      const candidate = { start_line: s.line, start_offset: s.offset, end_line: e.line, end_offset: e.offset }
      const bucket = byLine.get(s.line)
      if (bucket) bucket.push(candidate)
      else byLine.set(s.line, [candidate])
    }
  }

  // Never re-anchor on top of another annotation's span; prefer the next
  // free occurrence on that line, then keep searching outward.
  const taken = new Set(all
    .filter((x) => x.id !== a.id)
    .map((x) => `${x.range.start_line}:${x.range.start_offset}`))

  for (const i of order) {
    for (const candidate of byLine.get(i) ?? []) {
      if (!taken.has(`${candidate.start_line}:${candidate.start_offset}`)) return candidate
    }
  }
  // No free occurrence. Orphan the note rather than park it on top of
  // another one: two marks over the same characters is how a note ends up
  // labelling text it was never about.
  return null
}
