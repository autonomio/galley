// The DocumentStore contract (src/stores/types.ts), checked against every
// store Galley ships. A new store joins by adding a line to STORES.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConflictError } from '../../src/core/errors.js'
import { createMemoryStore } from '../../src/stores/memory.js'
import { createFileStore } from '../../src/server/file-store.js'
import type { Annotation, WriteContext } from '../../src/types.js'

interface ContractStore {
  list: ReturnType<typeof createMemoryStore>['list']
  create: ReturnType<typeof createMemoryStore>['create']
  read: ReturnType<typeof createMemoryStore>['read']
  write(slug: string, content: string, context: WriteContext): ReturnType<ReturnType<typeof createMemoryStore>['write']>
  remove: ReturnType<typeof createMemoryStore>['remove']
  readAnnotations: ReturnType<typeof createMemoryStore>['readAnnotations']
  writeAnnotations(slug: string, annotations: Annotation[], context: WriteContext): ReturnType<ReturnType<typeof createMemoryStore>['writeAnnotations']>
}

const dirs: string[] = []
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))) })

const STORES: [string, () => Promise<ContractStore>][] = [
  ['memory store', async () => createMemoryStore()],
  ['file store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'galley-contract-'))
    dirs.push(dir)
    return createFileStore({ dir })
  }],
]

const note = (id: string): Annotation => ({
  id,
  range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 5 },
  snippet: 'Hello',
  comment: 'a note',
  created_at: '2026-11-18T00:00:00.000Z',
  updated_at: '2026-11-18T00:00:00.000Z',
})

describe.each(STORES)('%s', (_name, make) => {
  it('creates, lists, reads and writes a document', async () => {
    const store = await make()
    const created = await store.create()
    expect(created.slug).toMatch(/^untitled-/)
    const read = await store.read(created.slug)
    expect(read.content).toBe('')
    const written = await store.write(created.slug, '# Hello\n\nworld', { clientId: 'a', revision: 1, baseVersion: read.version })
    expect(written.title).toBe('Hello')
    expect(written.version).not.toBe(read.version)
    expect((await store.read(created.slug)).content).toBe('# Hello\n\nworld')
    const listed = await store.list()
    expect(listed.map((d) => d.slug)).toContain(created.slug)
    expect(listed.find((d) => d.slug === created.slug)?.title).toBe('Hello')
  })

  it('refuses a write based on a version that is no longer current', async () => {
    const store = await make()
    const { slug } = await store.create()
    const base = (await store.read(slug)).version
    await store.write(slug, 'from tab one', { clientId: 'one', revision: 1, baseVersion: base })
    await expect(store.write(slug, 'from tab two', { clientId: 'two', revision: 1, baseVersion: base }))
      .rejects.toBeInstanceOf(ConflictError)
    expect((await store.read(slug)).content).toBe('from tab one')
  })

  it('lets one client keep advancing from the same base while its own write is current', async () => {
    const store = await make()
    const { slug } = await store.create()
    const base = (await store.read(slug)).version
    await store.write(slug, 'one', { clientId: 'a', revision: 1, baseVersion: base })
    await store.write(slug, 'one two', { clientId: 'a', revision: 2, baseVersion: base })
    expect((await store.read(slug)).content).toBe('one two')
  })

  it('acknowledges and drops a stale revision', async () => {
    const store = await make()
    const { slug } = await store.create()
    const base = (await store.read(slug)).version
    await store.write(slug, 'newest', { clientId: 'a', revision: 5, baseVersion: base })
    const stale = await store.write(slug, 'older', { clientId: 'a', revision: 4, baseVersion: base })
    expect(stale.stale).toBe(true)
    expect((await store.read(slug)).content).toBe('newest')
  })

  it('treats a missing document as a conflict for a versioned write', async () => {
    const store = await make()
    await expect(store.write('never-made', 'x', { clientId: 'a', revision: 1, baseVersion: 'whatever' }))
      .rejects.toBeInstanceOf(ConflictError)
    await expect(store.read('never-made')).rejects.toThrow()
  })

  it('rejects a slug that is not canonical', async () => {
    const store = await make()
    await expect(store.read('../escape')).rejects.toThrow('invalid slug')
    await expect(store.read('a b')).rejects.toThrow('invalid slug')
  })

  it('keeps notes beside the document and removes them with it', async () => {
    const store = await make()
    const { slug } = await store.create()
    const empty = await store.readAnnotations(slug)
    expect(empty.annotations).toEqual([])
    const saved = await store.writeAnnotations(slug, [note('n1')], { clientId: 'a', revision: 1, baseVersion: empty.version })
    const read = await store.readAnnotations(slug)
    expect(read.annotations).toEqual([note('n1')])
    expect(read.version).toBe(saved.version)
    await expect(store.writeAnnotations(slug, [], { clientId: 'b', revision: 1, baseVersion: empty.version }))
      .rejects.toBeInstanceOf(ConflictError)
    await store.remove(slug)
    expect((await store.list()).map((d) => d.slug)).not.toContain(slug)
    expect((await store.readAnnotations(slug)).annotations).toEqual([])
  })
})
