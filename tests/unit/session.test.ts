// The document session's persistence rules, against a memory store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentSession, type Notice, type SaveState } from '../../src/editor/session.js'
import { createMemoryStore } from '../../src/stores/memory.js'
import type { DocumentStore } from '../../src/stores/types.js'

function setup(store: DocumentStore = createMemoryStore({ documents: { doc: 'hello' } })) {
  const states: SaveState[] = []
  const notices: Notice[] = []
  const session = new DocumentSession(store, {
    status: (state) => states.push(state),
    notice: (notice) => notices.push(notice),
    documents: () => {},
  }, { save: 50, annotations: 50 })
  return { session, store, states, notices }
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

  it('reports a conflict instead of overwriting another writer', async () => {
    const { session, store, notices, states } = await opened()
    await store.write('doc', 'theirs', { clientId: 'other', revision: 1, baseVersion: session.version('doc')! })
    session.scheduleSave('mine')
    expect(await session.flush()).toBe(false)
    expect((await store.read('doc')).content).toBe('theirs')
    expect(states.at(-1)).toBe('unsaved')
    expect(notices.at(-1)).toMatchObject({ source: 'save', level: 'attention' })
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
