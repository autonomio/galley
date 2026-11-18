import { describe, expect, it } from 'vitest'
import { HistoryTooLargeError, HISTORY_BYTE_BUDGET, HISTORY_LIMIT, readHistory, trimHistoryStacks, writeHistory, type HistorySnapshot } from '../../src/core/history.js'

const key = (slug: string) => `galley-history:${slug}`

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}
const entry = (text: string) => ({ text, line: 0, offset: text.length })
const snapshot = (): HistorySnapshot => ({ version: 1, current: entry('second'), undo: [entry('first')], redo: [entry('third')] })

describe('persistent editor history', () => {
  it('retains both stacks and caret across a new reader, separately for each document', () => {
    const store = storage()
    writeHistory(store, key('notes'), snapshot())
    expect(readHistory(store, key('other'), 'second')).toBeNull()
    expect(readHistory(store, key('notes'), 'second')).toEqual(snapshot())
    expect(readHistory(store, key('notes'), 'second')).toEqual(snapshot())
  })

  it('discards external edits permanently instead of reviving a stale timeline later', () => {
    const store = storage()
    writeHistory(store, key('notes'), snapshot())
    expect(readHistory(store, key('notes'), 'external edit')).toBeNull()
    expect(readHistory(store, key('notes'), 'second')).toBeNull()
  })

  it.each([
    '{',
    JSON.stringify({ ...snapshot(), version: 2 }),
    JSON.stringify({ ...snapshot(), undo: [{ text: 'bad', line: -1, offset: 0 }] }),
    JSON.stringify({ ...snapshot(), redo: [{ text: 'bad', line: 0, offset: '0' }] }),
    JSON.stringify({ ...snapshot(), undo: Array.from({ length: HISTORY_LIMIT + 1 }, () => entry('too many')) }),
  ])('rejects malformed or unsupported storage: %s', (raw) => {
    const store = storage()
    store.setItem(key('notes'), raw)
    expect(readHistory(store, key('notes'), 'second')).toBeNull()
    expect(store.getItem(key('notes'))).toBeNull()
  })

  it('removes an old timeline when there are no steps', () => {
    const store = storage()
    writeHistory(store, key('notes'), snapshot())
    writeHistory(store, key('notes'), { ...snapshot(), undo: [], redo: [] })
    expect(store.getItem(key('notes'))).toBeNull()
  })

  it('reports denied or incomplete writes so updates can wait', () => {
    const store = storage()
    expect(() => writeHistory({ ...store, setItem: () => { throw new Error('quota') } }, key('notes'), snapshot())).toThrow('quota')
    expect(() => writeHistory({ ...store, setItem: () => {} }, key('notes'), snapshot())).toThrow('complete snapshot')
  })
})

describe('history byte budget', () => {
  const big = (label: string) => ({ text: `${label}:${'x'.repeat(100)}`, line: 0, offset: 0 })
  const kept = (entries: { text: string }[]) => entries.map((entry) => entry.text.split(':')[0])

  it('trims the oldest undo steps first and keeps the newest within budget', () => {
    const undo = [big('oldest'), big('middle'), big('newest')]
    const redo = [big('future')]
    const sizes = [...undo, ...redo].map((entry) => JSON.stringify(entry).length + 1)
    const dropped = trimHistoryStacks(undo, redo, sizes[1] + sizes[2] + sizes[3])
    expect(dropped).toBe(1)
    expect(kept(undo)).toEqual(['middle', 'newest'])
    expect(kept(redo)).toEqual(['future'])
  })

  it('trims redo once undo is exhausted', () => {
    const undo = [big('only')]
    const redo = [big('first'), big('second')]
    const dropped = trimHistoryStacks(undo, redo, JSON.stringify(redo[1]).length + 1)
    expect(dropped).toBe(2)
    expect(undo).toHaveLength(0)
    expect(kept(redo)).toEqual(['second'])
  })

  it('keeps stacks that already fit', () => {
    const undo = [big('a')]
    const redo = [big('b')]
    expect(trimHistoryStacks(undo, redo, HISTORY_BYTE_BUDGET)).toBe(0)
    expect(undo).toHaveLength(1)
    expect(redo).toHaveLength(1)
  })

  it('persists the newest steps within the byte budget and reports the cut', () => {
    const store = storage()
    const text = (i: number) => `v${i}:` + 'x'.repeat(10_000)
    const timeline: HistorySnapshot = {
      version: 1,
      current: entry(text(999)),
      undo: Array.from({ length: 150 }, (_, i) => entry(text(i))),
      redo: [],
    }
    const dropped = writeHistory(store, key('notes'), timeline)
    expect(dropped).toBeGreaterThan(0)
    expect(store.getItem(key('notes'))!.length).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET)
    const restored = readHistory(store, key('notes'), text(999))!
    expect(restored.undo.length).toBeLessThan(150)
    expect(restored.undo.at(-1)?.text).toBe(text(149))
    // Trimming applies to the stored copy; the caller's stacks are untouched.
    expect(timeline.undo).toHaveLength(150)
  })

  it('refuses a document whose current entry alone exceeds the budget', () => {
    const store = storage()
    writeHistory(store, key('notes'), snapshot())
    const huge = 'x'.repeat(HISTORY_BYTE_BUDGET)
    expect(() => writeHistory(store, key('notes'), { version: 1, current: entry(huge), undo: [entry('first')], redo: [] }))
      .toThrow(HistoryTooLargeError)
    // The stale timeline must not linger and spend quota.
    expect(store.getItem(key('notes'))).toBeNull()
  })

  it('refuses an oversized document even after live trimming emptied its stacks', () => {
    const store = storage()
    writeHistory(store, key('notes'), snapshot())
    const huge = 'x'.repeat(HISTORY_BYTE_BUDGET)
    expect(() => writeHistory(store, key('notes'), { version: 1, current: entry(huge), undo: [], redo: [] }))
      .toThrow(HistoryTooLargeError)
    expect(store.getItem(key('notes'))).toBeNull()
  })

  it('removes the timeline when trimming drops every step', () => {
    const store = storage()
    const probe = 'c'.repeat(1_000_000)
    const fixed = JSON.stringify({ version: 1, current: entry(probe), undo: [], redo: [] }).length - probe.length
    const current = 'c'.repeat(HISTORY_BYTE_BUDGET - fixed - 10)
    const dropped = writeHistory(store, key('notes'), { version: 1, current: entry(current), undo: [entry('first')], redo: [] })
    expect(dropped).toBe(1)
    expect(store.getItem(key('notes'))).toBeNull()
  })

  it('keeps every document timeline within the budget without mixing them', () => {
    const store = storage()
    for (const slug of ['notes', 'other']) {
      writeHistory(store, key(slug), {
        version: 1,
        current: entry('current'),
        undo: Array.from({ length: 50 }, (_, i) => entry(`${slug}-v${i}:` + 'x'.repeat(20_000))),
        redo: [],
      })
      expect(store.getItem(key(slug))!.length).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET)
    }
    expect(readHistory(store, key('notes'), 'current')!.undo.at(-1)?.text).toMatch(/^notes-v49:/)
    expect(readHistory(store, key('other'), 'current')!.undo.at(-1)?.text).toMatch(/^other-v49:/)
  })
})
