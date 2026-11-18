import { describe, expect, it } from 'vitest'
import { reAnchor, rangeText } from '../../src/core/anchoring.js'
import { applyEdit, findEditRange } from '../../src/core/edits.js'
import type { Annotation, AnnotationRange } from '../../src/types.js'

const note = (id: string, range: AnnotationRange, snippet: string): Annotation =>
  ({ id, range, snippet, comment: '', created_at: '', updated_at: '' })
const at = (line: number, start: number, end: number): AnnotationRange =>
  ({ start_line: line, start_offset: start, end_line: line, end_offset: end })

describe('reAnchor', () => {
  it('keeps a note whose passage has not moved', () => {
    const a = note('a', at(1, 0, 5), 'Hello')
    expect(reAnchor(a, ['# Title', 'Hello world'], [a])).toBe(a.range)
  })

  it('follows a passage when lines are inserted above it', () => {
    const a = note('a', at(1, 0, 5), 'Hello')
    expect(reAnchor(a, ['# Title', 'new line', 'Hello world'], [a])).toEqual(at(2, 0, 5))
  })

  it('prefers the nearest occurrence, not the first in the document', () => {
    const a = note('a', at(3, 0, 4), 'Note')
    expect(reAnchor(a, ['Note', 'x', 'y', 'z', 'Note here'], [a])).toEqual(at(4, 0, 4))
  })

  it('never lands on another note', () => {
    const a = note('a', at(0, 0, 4), 'Note')
    const b = note('b', at(5, 0, 4), 'Note')
    expect(reAnchor(b, ['Note', 'Note'], [a, b])).toEqual(at(1, 0, 4))
  })

  it('re-finds a passage across lines', () => {
    const a = note('a', { start_line: 0, start_offset: 3, end_line: 1, end_offset: 3 }, 'two\nthr')
    const lines = ['inserted', 'one two', 'three']
    expect(reAnchor(a, lines, [a])).toEqual({ start_line: 1, start_offset: 4, end_line: 2, end_offset: 3 })
    expect(rangeText(lines, reAnchor(a, lines, [a])!)).toBe('two\nthr')
  })

  it('orphans a note whose passage is gone, and survives an empty snippet', () => {
    expect(reAnchor(note('a', at(0, 0, 4), 'gone'), ['nothing here'], [])).toBeNull()
    expect(reAnchor(note('a', at(9, 0, 0), ''), ['text'], [])).toBeNull()
  })
})

describe('edits', () => {
  it('replaces a unique passage', () => {
    expect(applyEdit('one two three', { old: 'two', new: '2' })).toEqual({ text: 'one 2 three', start: 4 })
  })

  it('refuses an ambiguous passage without context, and resolves it with context', () => {
    const text = 'a cat, a cat'
    expect(findEditRange(text, { old: 'cat', new: 'dog' })).toBeNull()
    expect(findEditRange(text, { old: 'cat', new: 'dog', context_before: 'cat, a ' })).toEqual({ start: 9, end: 12 })
  })

  it('inserts after its anchor and never blind', () => {
    expect(applyEdit('Hello world', { old: '', new: ',', context_before: 'Hello' })?.text).toBe('Hello, world')
    expect(findEditRange('Hello', { old: '', new: 'x' })).toBeNull()
  })
})
