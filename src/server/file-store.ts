// Documents as plain UTF-8 markdown files in one directory. No metadata
// header, no database row, no schema: a document's slug is its filename
// without `.md`, and its title is derived from the first non-empty line at
// read time, so a writer renames a document by editing line 1.
//
// Why files: this is the writer's own corpus. Plain markdown files in a
// folder they choose integrate with whatever versioning, sync or backup
// they already have (git, Dropbox, iCloud). No lock-in.
//
// Notes live beside each document as `<slug>.annotations.json`, so the
// markdown stays pristine.
import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { ConflictError } from '../core/errors.js'
import { canonicalSlug, isCanonicalSlug, newSlug } from '../core/slug.js'
import { WriteGuard, validWriteContext } from '../core/write-guard.js'
import { deriveTitle } from '../markdown/title.js'
import type {
  Annotation,
  AnnotationsRead,
  AnnotationsWriteResult,
  DocRead,
  DocSummary,
  DocWriteResult,
  Version,
  WriteContext,
} from '../types.js'

/** Cap per document so a runaway paste or a corrupt sync can't blow out memory. */
export const MAX_DOC_BYTES = 5 * 1024 * 1024
/** 1 MB of notes per document — many hundreds of comments. */
export const MAX_ANNOTATIONS_BYTES = 1 * 1024 * 1024
const STALE_TMP_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Runs `operation` exclusively for `key`. The default serializes within this
 * process; pass a cross-process lock when several processes write one folder.
 */
export type Lock = <T>(key: string, operation: () => Promise<T>) => Promise<T>

export interface FileStoreOptions {
  /** The folder documents live in. Created when missing. */
  dir: string
  lock?: Lock
  /**
   * Side-car suffixes deleted with a document, besides `annotations.json`:
   * `<slug>.<suffix>`. A host that keeps its own side-cars names them here.
   */
  sidecars?: string[]
}

export interface FileStore {
  readonly dir: string
  /** Settles once startup cleanup has run; every operation waits for it. */
  readonly ready: Promise<void>
  list(): Promise<DocSummary[]>
  create(): Promise<DocWriteResult>
  read(slug: string, options?: { noFollow?: boolean }): Promise<DocRead>
  /** Without a context the write is unconditional (for trusted server-side writers). */
  write(slug: string, content: string, context?: WriteContext): Promise<DocWriteResult>
  remove(slug: string): Promise<void>
  readAnnotations(slug: string): Promise<AnnotationsRead>
  writeAnnotations(slug: string, annotations: Annotation[], context?: WriteContext): Promise<AnnotationsWriteResult>
}

function versionFor(content: string): Version {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// Missing state needs its own version so deleting an empty document cannot be
// mistaken for leaving an empty document unchanged.
const MISSING_DOC_VERSION = versionFor('galley:missing-document:v1')
const MISSING_ANNOTATIONS_VERSION = versionFor('galley:missing-annotations:v1')

// Same-process order per target, then the (optional) shared lock around
// each read/compare/write transaction.
function createSerializer(lock: Lock) {
  const tails = new Map<string, Promise<void>>()
  return async function serialize<T>(target: string, mutation: () => Promise<T>): Promise<T> {
    const previous = tails.get(target) || Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => { release = resolve })
    tails.set(target, tail)
    await previous
    try {
      return await lock(target, mutation)
    } finally {
      release()
      if (tails.get(target) === tail) tails.delete(target)
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    // Windows does not consistently support opening/fsyncing directories.
    // POSIX directory fsync errors remain fatal: rename durability could not
    // be established.
    const code = (error as NodeJS.ErrnoException)?.code ?? ''
    const unsupportedOnWindows = process.platform === 'win32' && ['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code)
    if (!unsupportedOnWindows) throw error
  } finally {
    await handle?.close()
  }
}

// Every write goes to a sibling temp file, then renames over the target.
// POSIX rename is atomic: readers see the old file or the new one, never half
// of one. A failed write leaves the target untouched. The temp name carries
// pid + time + a counter so concurrent writes never share a path.
let tmpCounter = 0
async function writeAtomic(target: string, content: string): Promise<void> {
  const tmpPath = `${target}.tmp.${process.pid}.${Date.now()}.${++tmpCounter}`
  let handle
  try {
    let mode = 0o600
    try { mode = (await stat(target)).mode & 0o777 } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    handle = await open(tmpPath, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmpPath, target)
    await syncDirectory(dirname(target))
  } catch (error) {
    try { await handle?.close() } catch { /* best-effort */ }
    try { await unlink(tmpPath) } catch { /* swept at startup too */ }
    throw error
  }
}

async function readUtf8Limited(path: string, maxBytes: number, label: string, noFollow = false) {
  const handle = await open(path, noFollow ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : 'r')
  try {
    const info = await handle.stat()
    if (noFollow && !info.isFile()) throw new Error('the document source is not a regular file')
    if (info.size > maxBytes) throw new Error(`${label} too large (max ${maxBytes} bytes)`)
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return { content: buffer.subarray(0, offset).toString('utf-8'), updatedAt: info.mtime.toISOString(), size: info.size }
  } finally {
    await handle.close()
  }
}

// Read only as far as the first non-empty line.
async function readTitle(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(4096, Math.max(1, maxBytes)))
    const decoder = new StringDecoder('utf8')
    const parts: string[] = []
    let offset = 0
    let nonempty = false
    while (offset < maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - offset), offset)
      if (!bytesRead) break
      offset += bytesRead
      for (const part of decoder.write(buffer.subarray(0, bytesRead)).split(/(?<=\n)/)) {
        parts.push(part)
        nonempty ||= part.trim().length > 0
        if (nonempty && part.endsWith('\n')) return deriveTitle(parts.join(''))
      }
    }
    parts.push(decoder.end())
    return deriveTitle(parts.join(''))
  } finally {
    await handle.close()
  }
}

export function createFileStore(options: FileStoreOptions): FileStore {
  const dir = options.dir
  const serialize = createSerializer(options.lock ?? ((_key, operation) => operation()))
  const guard = new WriteGuard()
  const sidecars = ['annotations.json', ...(options.sidecars ?? [])]
  const fileFor = (slug: string) => join(dir, `${canonicalSlug(slug)}.md`)
  const annotationsFileFor = (slug: string) => join(dir, `${canonicalSlug(slug)}.annotations.json`)
  // Metadata is rechecked on every listing, including edits made elsewhere.
  const summaryCache = new Map<string, { fingerprint: string, summary: DocSummary }>()

  // On startup, sweep temp files a crash left behind. Only old ones: another
  // process may be inside writeAtomic right now.
  const ready = (async () => {
    await mkdir(dir, { recursive: true })
    let names: string[] = []
    try { names = await readdir(dir) } catch { return }
    for (const name of names) {
      const match = name.match(/\.tmp\.\d+\.(\d+)(?:\.\d+)?$/)
      if (!match) continue
      const createdAt = Number(match[1])
      if (!Number.isFinite(createdAt) || Date.now() - createdAt < STALE_TMP_AGE_MS) continue
      try { await unlink(join(dir, name)) } catch { /* best-effort */ }
    }
  })()

  async function list(): Promise<DocSummary[]> {
    await ready
    let names: string[] = []
    try { names = await readdir(dir) } catch { return [] }
    const slugs = names.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).filter(isCanonicalSlug)
    const order = new Map(slugs.map((slug, index) => [slug, index]))
    const present = new Set(slugs)
    for (const slug of summaryCache.keys()) if (!present.has(slug)) summaryCache.delete(slug)
    const out: DocSummary[] = []
    let next = 0
    // Bound open files and disk work even for libraries of thousands of notes.
    await Promise.all(Array.from({ length: Math.min(8, slugs.length) }, async () => {
      while (next < slugs.length) {
        const slug = slugs[next++]
        const fullPath = join(dir, `${slug}.md`)
        try {
          const st = await stat(fullPath, { bigint: true })
          if (!st.isFile()) continue
          const fingerprint = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
          let cached = summaryCache.get(slug)
          if (cached?.fingerprint !== fingerprint) {
            const title = await readTitle(fullPath, Math.min(Number(st.size), MAX_DOC_BYTES))
            cached = {
              fingerprint,
              summary: { slug, title, updated_at: new Date(Math.round(Number(st.mtimeNs) / 1_000_000)).toISOString(), size: Number(st.size) },
            }
            summaryCache.set(slug, cached)
          }
          out.push({ ...cached.summary })
        } catch { /* skip unreadable files */ }
      }
    }))
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || order.get(a.slug)! - order.get(b.slug)!)
    return out
  }

  async function read(slug: string, readOptions: { noFollow?: boolean } = {}): Promise<DocRead> {
    await ready
    const loaded = await readUtf8Limited(fileFor(slug), MAX_DOC_BYTES, 'doc', readOptions.noFollow)
    return { slug: canonicalSlug(slug), content: loaded.content, updated_at: loaded.updatedAt, version: versionFor(loaded.content) }
  }

  async function write(slug: string, content: string, writeContext?: WriteContext): Promise<DocWriteResult> {
    if (typeof content !== 'string') throw new Error('content must be a string')
    if (Buffer.byteLength(content, 'utf-8') > MAX_DOC_BYTES) throw new Error(`doc too large (max ${MAX_DOC_BYTES} bytes)`)
    await ready
    const path = fileFor(slug)
    const context = writeContext === undefined ? null : validWriteContext(writeContext)
    return serialize(path, async () => {
      if (context) {
        let current
        try {
          current = await readUtf8Limited(path, MAX_DOC_BYTES, 'doc')
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new ConflictError(MISSING_DOC_VERSION)
          throw error
        }
        const currentVersion = versionFor(current.content)
        if (guard.admit(path, context, currentVersion) === 'stale') {
          return {
            slug: canonicalSlug(slug), title: deriveTitle(current.content), updated_at: current.updatedAt,
            size: current.size, version: currentVersion, stale: true,
          }
        }
      }
      await writeAtomic(path, content)
      const st = await stat(path)
      const version = versionFor(content)
      if (context) guard.remember(path, context, version)
      return { slug: canonicalSlug(slug), title: deriveTitle(content), updated_at: st.mtime.toISOString(), size: st.size, version }
    })
  }

  async function remove(slug: string): Promise<void> {
    await ready
    const path = fileFor(slug)
    const removeOne = (target: string) => serialize(target, async () => {
      try { await unlink(target) } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      }
      guard.forget(target)
    })
    // The document first: a side-car written meanwhile is either removed
    // with the rest or finds the document gone.
    await removeOne(path)
    await Promise.all(sidecars.map((suffix) => removeOne(join(dir, `${canonicalSlug(slug)}.${suffix}`))))
  }

  async function readAnnotations(slug: string): Promise<AnnotationsRead> {
    await ready
    try {
      const raw = (await readUtf8Limited(annotationsFileFor(slug), MAX_ANNOTATIONS_BYTES, 'annotations')).content
      return { annotations: parseAnnotations(raw), version: versionFor(raw) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { annotations: [], version: MISSING_ANNOTATIONS_VERSION }
      // Corrupt JSON or an unreadable file: never silently lose notes.
      throw error
    }
  }

  async function writeAnnotations(slug: string, annotations: Annotation[], writeContext?: WriteContext): Promise<AnnotationsWriteResult> {
    if (!Array.isArray(annotations)) throw new Error('annotations must be an array')
    const body = JSON.stringify({ annotations }, null, 2)
    if (Buffer.byteLength(body, 'utf-8') > MAX_ANNOTATIONS_BYTES) throw new Error(`annotations too large (max ${MAX_ANNOTATIONS_BYTES} bytes)`)
    await ready
    const path = annotationsFileFor(slug)
    const context = writeContext === undefined ? null : validWriteContext(writeContext)
    return serialize(path, async () => {
      if (context) {
        let currentVersion = MISSING_ANNOTATIONS_VERSION
        try {
          currentVersion = versionFor((await readUtf8Limited(path, MAX_ANNOTATIONS_BYTES, 'annotations')).content)
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
        }
        if (guard.admit(path, context, currentVersion) === 'stale') return { version: currentVersion, stale: true }
      }
      await writeAtomic(path, body)
      const version = versionFor(body)
      if (context) guard.remember(path, context, version)
      return { version }
    })
  }

  return {
    dir,
    ready,
    list,
    create: () => write(newSlug(), ''),
    read,
    write,
    remove,
    readAnnotations,
    writeAnnotations,
  }
}

function parseAnnotations(raw: string): Annotation[] {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Array.isArray((parsed as { annotations?: unknown }).annotations)) {
    throw new Error('annotations must be an array')
  }
  return (parsed as { annotations: Annotation[] }).annotations
}
