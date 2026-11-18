// The wire protocol end to end: the browser's HTTP store against the server
// handler over a real socket, backed by files.
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConflictError } from '../../src/core/errors.js'
import { createHttpStore } from '../../src/stores/http.js'
import { createFileStore } from '../../src/server/file-store.js'
import { createGalleyHandler } from '../../src/server/http.js'

let dir: string
let server: Server
let base: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'galley-http-'))
  const handler = createGalleyHandler({ store: createFileStore({ dir }), basePath: '/api/editor' })
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

const store = () => createHttpStore({ baseUrl: `${base}/api/editor` })

describe('HTTP protocol', () => {
  it('round-trips a document as a markdown file', async () => {
    const { slug } = await store().create()
    const read = await store().read(slug)
    const written = await store().write(slug, '# Title\n\nBody', { clientId: 'c', revision: 1, baseVersion: read.version })
    expect(written.title).toBe('Title')
    expect(await readFile(join(dir, `${slug}.md`), 'utf8')).toBe('# Title\n\nBody')
    expect((await store().list()).find((d) => d.slug === slug)?.title).toBe('Title')
  })

  it('answers a stale base with 409 and the current version', async () => {
    const { slug } = await store().create()
    const read = await store().read(slug)
    await writeFile(join(dir, `${slug}.md`), 'changed outside')
    const attempt = store().write(slug, 'mine', { clientId: 'c', revision: 1, baseVersion: read.version })
    await expect(attempt).rejects.toBeInstanceOf(ConflictError)
    const error = await attempt.catch((e: unknown) => e) as ConflictError
    expect(error.currentVersion).toBe((await store().read(slug)).version)
    expect(await readFile(join(dir, `${slug}.md`), 'utf8')).toBe('changed outside')
  })

  it('refuses a browser write that does not say what it replaces', async () => {
    const { slug } = await store().create()
    const res = await fetch(`${base}/api/editor/doc/${slug}`, { method: 'PUT', body: JSON.stringify({ content: 'blind' }) })
    expect(res.status).toBe(428)
  })

  it('accepts POST as the beacon alias of PUT', async () => {
    const { slug } = await store().create()
    const read = await store().read(slug)
    const res = await fetch(`${base}/api/editor/doc/${slug}`, {
      method: 'POST',
      body: JSON.stringify({ content: 'from a beacon', client_id: 'b', revision: 1, base_version: read.version }),
    })
    expect(res.status).toBe(200)
    expect((await store().read(slug)).content).toBe('from a beacon')
  })

  it('saves and deletes notes with their document', async () => {
    const { slug } = await store().create()
    const empty = await store().readAnnotations(slug)
    await store().writeAnnotations(slug, [{
      id: 'n', range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 1 },
      snippet: 'x', comment: 'note', created_at: '', updated_at: '',
    }], { clientId: 'c', revision: 1, baseVersion: empty.version })
    expect((await readdir(dir)).filter((f) => f.startsWith(slug))).toHaveLength(2)
    await store().remove(slug)
    expect((await readdir(dir)).filter((f) => f.startsWith(slug))).toHaveLength(0)
  })

  it('answers 404 for a missing document and 400 for an invalid slug', async () => {
    expect((await fetch(`${base}/api/editor/doc/missing-doc`)).status).toBe(404)
    expect((await fetch(`${base}/api/editor/doc/.hidden`)).status).toBe(400)
  })

  it('leaves other routes alone', async () => {
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404)
  })
})
