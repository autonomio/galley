// The document session's persistence rules, against a memory store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentSession, type Notice, type SaveState } from '../../src/editor/session.js'
import { createMemoryStore } from '../../src/stores/memory.js'
import type { DocumentStore } from '../../src/stores/types.js'

function setup(store: DocumentStore = createMemoryStore({ documents: { doc: 'hello' } })) {
  const states: SaveState[] = []
  const notices: Notice[] = []
  const rebased: string[] = []
  const session = new DocumentSession(store, {
    status: (state) => states.push(state),
    notice: (notice) => notices.push(notice),
    documents: () => {},
    rebased: (_slug, _ours, merged) => rebased.push(merged),
  }, { save: 50, annotations: 50 })
  return { session, store, states, notices, rebased }
}

async function opened(store?: DocumentStore) {
  const ctx = setup(store)
  ctx.session.open(await ctx.session.read('doc'))
  return ctx
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('DocumentSession', () => {
  it('debounces edits into one save and reports editing, saving, saved', async () => {
    const { session, store, states } = await opened()
    session.scheduleSave('hello w')
    session.scheduleSave('hello world')
    await vi.advanceTimersByTimeAsync(60)
    expect((await store.read('doc')).content).toBe('hello world')
    expect(states).toEqual(['editing', 'editing', 'saving', 'saved'])
    expect(session.isDirty()).toBe(false)
  })

  it('merges a change made elsewhere with ours, line by line', async () => {
    const { session, store, notices, rebased } = await opened(createMemoryStore({ documents: { doc: 'one\ntwo\nthree' } }))
    await store.write('doc', 'ONE\ntwo\nthree', { clientId: 'agent', revision: 1, baseVersion: session.version('doc')! })
    session.scheduleSave('one\ntwo\nTHREE')
    expect(await session.flush()).toBe(true)
    expect((await store.read('doc')).content).toBe('ONE\ntwo\nTHREE')
    expect(rebased).toEqual(['ONE\ntwo\nTHREE'])
    expect(notices.filter((n) => n.level === 'attention')).toEqual([])
  })

  it('keeps our lines where both writers changed the same ones, and says so', async () => {
    const { session, store, notices } = await opened()
    await store.write('doc', 'theirs', { clientId: 'other', revision: 1, baseVersion: session.version('doc')! })
    session.scheduleSave('mine')
    expect(await session.flush()).toBe(true)
    expect((await store.read('doc')).content).toBe('mine')
    expect(notices).toContainEqual(expect.objectContaining({ source: 'merge', level: 'attention' }))
  })

  it('merges notes changed elsewhere, reply by reply', async () => {
    const { session, store } = await opened()
    await session.loadAnnotations('doc')
    const note = { id: 'n', range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 5 }, snippet: 'hello', comment: 'Is this right?', created_at: '', updated_at: '' }
    session.annotations.push({ ...note })
    session.scheduleAnnotationsSave()
    expect(await session.flush()).toBe(true)
    const theirs = await store.readAnnotations('doc')
    const reply = { id: 'r1', author: { name: 'Author', kind: 'agent' as const }, text: 'Yes.', created_at: '2026-01-01T00:00:00Z' }
    await store.writeAnnotations('doc', [{ ...note, replies: [reply] }], { clientId: 'agent', revision: 1, baseVersion: theirs.version })
    session.annotations[0].resolved = true
    session.scheduleAnnotationsSave()
    expect(await session.flush()).toBe(true)
    expect((await store.readAnnotations('doc')).annotations).toEqual([expect.objectContaining({ id: 'n', resolved: true, replies: [reply] })])
  })

  it('discards pending text when asked, and saves nothing for a document being deleted', async () => {
    const { session, store } = await opened()
    session.scheduleSave('never')
    await session.discard()
    session.deletingSlug = 'doc'
    session.scheduleSave('also never')
    await vi.advanceTimersByTimeAsync(60)
    expect((await store.read('doc')).content).toBe('hello')
  })

  it('keeps notes read-only until they have loaded', async () => {
    const { session, notices } = await opened()
    session.annotations.push({ id: 'n', range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 5 }, snippet: 'hello', comment: '', created_at: '', updated_at: '' })
    session.scheduleAnnotationsSave()
    expect(notices.at(-1)).toMatchObject({ source: 'annotations', level: 'error' })
    await session.loadAnnotations('doc')
    session.annotations.push({ id: 'n', range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 5 }, snippet: 'hello', comment: 'kept', created_at: '', updated_at: '' })
    session.scheduleAnnotationsSave()
    expect(await session.flush()).toBe(true)
  })

  it('saves nothing while frozen', async () => {
    const { session, store } = await opened()
    session.frozen = true
    session.scheduleSave('while frozen')
    await vi.advanceTimersByTimeAsync(60)
    expect((await store.read('doc')).content).toBe('hello')
  })

  it('hands pending saves to the store on unload', async () => {
    const { session, store } = await opened()
    session.scheduleSave('unload me')
    session.sendBeacons()
    expect((await store.read('doc')).content).toBe('unload me')
  })
})
