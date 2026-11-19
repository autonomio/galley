// Three-way merges: two writers' changes from one starting point.
import { describe, expect, it } from 'vitest'
import { merge3, mergeAnnotations } from '../../src/core/merge.js'
import type { Annotation } from '../../src/types.js'

const base = ['# Title', '', 'First paragraph.', '', 'Second paragraph.', '', 'Third paragraph.'].join('\n')

describe('merge3', () => {
  it('takes each side where only that side changed', () => {
    const ours = base.replace('First paragraph.', 'First paragraph, edited by a person.')
    const theirs = base.replace('Third paragraph.', 'Third paragraph, revised by an agent.')
    expect(merge3(base, ours, theirs)).toEqual({ text: ours.replace('Third paragraph.', 'Third paragraph, revised by an agent.'), conflicts: 0 })
  })

  it('keeps insertions from both sides', () => {
    const ours = base.replace('First paragraph.', 'First paragraph.\n\nA note of mine.')
    const theirs = base + '\n\nA new section from the Author.'
    expect(merge3(base, ours, theirs).text).toBe(ours + '\n\nA new section from the Author.')
  })

  it('takes a deletion when the other side left the lines alone', () => {
    const ours = base.replace('Second paragraph.\n\n', '')
    expect(merge3(base, ours, base).text).toBe(ours)
    expect(merge3(base, base, ours).text).toBe(ours)
  })

  it('keeps our lines where both sides changed the same ones, and counts it', () => {
    const ours = base.replace('Second paragraph.', 'Second, as I wrote it.')
    const theirs = base.replace('Second paragraph.', 'Second, as the agent wrote it.')
    expect(merge3(base, ours, theirs)).toEqual({ text: ours, conflicts: 1 })
  })

  it('merges changes to neighbouring lines made on different sides', () => {
    expect(merge3('one\ntwo', 'one\ntwo and more', 'ONE\ntwo')).toEqual({ text: 'ONE\ntwo and more', conflicts: 0 })
  })

  it('agrees when both sides made the same change', () => {
    const same = base.replace('Third', 'Last')
    expect(merge3(base, same, same)).toEqual({ text: same, conflicts: 0 })
  })
})

const note = (id: string, extra: Partial<Annotation> = {}): Annotation => ({
  id, range: { start_line: 2, start_offset: 0, end_line: 2, end_offset: 5 }, snippet: 'First', comment: 'A question', created_at: 't0', updated_at: 't0', ...extra,
})
const reply = (id: string, text: string) => ({ id, author: { name: 'Author', kind: 'agent' as const }, text, created_at: `t-${id}` })

describe('mergeAnnotations', () => {
  it('keeps replies added on both sides, in order', () => {
    const b = [note('n')]
    const ours = [note('n', { replies: [{ ...reply('mine', 'My answer'), author: { name: 'You', kind: 'human' as const } }] })]
    const theirs = [note('n', { replies: [reply('d0', 'Fixed.')] })]
    const merged = mergeAnnotations(b, ours, theirs).annotations
    expect(merged[0].replies?.map((r) => r.id)).toEqual(['d0', 'mine'])
  })

  it('keeps a note added on either side, and drops one deleted on a side the other left alone', () => {
    const b = [note('a'), note('b')]
    const ours = [note('a'), note('mine')]
    const theirs = [note('a'), note('b'), note('theirs')]
    expect(mergeAnnotations(b, ours, theirs).annotations.map((a) => a.id)).toEqual(['a', 'mine', 'theirs'])
  })

  it('keeps a note one side changed even if the other deleted it', () => {
    const b = [note('a')]
    const ours: Annotation[] = []
    const theirs = [note('a', { replies: [reply('d0', 'Answered.')] })]
    expect(mergeAnnotations(b, ours, theirs).annotations.map((a) => a.id)).toEqual(['a'])
  })

  it('takes our field where both changed it, and counts it', () => {
    const b = [note('a')]
    const merged = mergeAnnotations(b, [note('a', { comment: 'Mine' })], [note('a', { comment: 'Theirs', resolved: true })])
    expect(merged.annotations[0]).toMatchObject({ comment: 'Mine', resolved: true })
    expect(merged.conflicts).toBe(1)
  })
})
