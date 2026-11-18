// Galley's HTTP protocol over any store, as a Connect-style handler: mount
// it in Vite, Express, Connect or a bare node:http server. See
// src/stores/http.ts for the client and the route table.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ConflictError } from '../core/errors.js'
import type { Annotation, AnnotationsRead, AnnotationsWriteResult, DocRead, DocSummary, DocWriteResult, WriteContext } from '../types.js'
import { MAX_ANNOTATIONS_BYTES, MAX_DOC_BYTES } from './file-store.js'

/** What the handler needs from a store. A FileStore is one; so is any DocumentStore. */
export interface ServedStore {
  list(): Promise<DocSummary[]>
  create(): Promise<DocWriteResult>
  read(slug: string): Promise<DocRead>
  write(slug: string, content: string, context: WriteContext): Promise<DocWriteResult>
  remove(slug: string): Promise<void>
  readAnnotations(slug: string): Promise<AnnotationsRead>
  writeAnnotations(slug: string, annotations: Annotation[], context: WriteContext): Promise<AnnotationsWriteResult>
}

export interface HandlerOptions {
  store: ServedStore
  /** Where the protocol is mounted. Default `/api/galley`. */
  basePath?: string
}

export type GalleyHandler = (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void) => Promise<void>

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message) }
}

const SLUG = '([A-Za-z0-9._-]+)'

export function createGalleyHandler(options: HandlerOptions): GalleyHandler {
  const base = (options.basePath ?? '/api/galley').replace(/\/+$/, '')
  const store = options.store
  const docsPath = `${base}/docs`
  const docRe = new RegExp(`^${escapeRe(base)}/doc/${SLUG}$`)
  const annotationsRe = new RegExp(`^${escapeRe(base)}/doc/${SLUG}/annotations$`)

  return async function galleyHandler(req, res, next) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const method = req.method ?? 'GET'
    try {
      if (path === docsPath && method === 'GET') return send(res, 200, { docs: await store.list() })
      if (path === docsPath && method === 'POST') return send(res, 200, await store.create())

      const docMatch = path.match(docRe)
      if (docMatch) {
        const slug = decodeURIComponent(docMatch[1])
        if (method === 'GET') return send(res, 200, await store.read(slug))
        if (method === 'PUT' || method === 'POST') {
          // JSON escaping can expand control-heavy Markdown by up to six bytes
          // per decoded byte; the store still enforces its own limit.
          const body = await readJson(req, MAX_DOC_BYTES * 6 + 1024)
          if (!isObject(body) || typeof body.content !== 'string') throw new HttpError(400, 'content must be a string')
          return send(res, 200, await store.write(slug, body.content, writeContext(body)))
        }
        if (method === 'DELETE') {
          await store.remove(slug)
          return send(res, 200, { ok: true })
        }
      }

      const annotationsMatch = path.match(annotationsRe)
      if (annotationsMatch) {
        const slug = decodeURIComponent(annotationsMatch[1])
        if (method === 'GET') return send(res, 200, await store.readAnnotations(slug))
        if (method === 'PUT' || method === 'POST') {
          const body = await readJson(req, MAX_ANNOTATIONS_BYTES + 1024)
          if (!isObject(body) || !Array.isArray(body.annotations)) throw new HttpError(400, 'annotations must be an array')
          const result = await store.writeAnnotations(slug, body.annotations as Annotation[], writeContext(body))
          return send(res, 200, { ok: true, ...result })
        }
      }
    } catch (error) {
      return sendError(res, error, method === 'GET' ? 500 : 400)
    }
    if (next) return next()
    send(res, 404, { error: 'not found' })
  }
}

// Every browser write must say what it replaces; an unconditional write
// from a page would silently overwrite another tab or an outside edit.
function writeContext(body: Record<string, unknown>): WriteContext {
  if (body.client_id === undefined && body.revision === undefined && body.base_version === undefined) {
    throw new HttpError(428, 'editor write precondition is required; reload the document')
  }
  return { clientId: body.client_id as string, revision: body.revision as number, baseVersion: body.base_version as string }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, error: unknown, fallback: number): void {
  const err = error as { message?: string, statusCode?: unknown, status?: unknown, code?: unknown }
  if (error instanceof ConflictError) {
    return send(res, 409, { error: error.message, current_version: error.currentVersion })
  }
  const status = err?.code === 'ENOENT' ? 404
    : typeof err?.statusCode === 'number' ? err.statusCode
      : typeof err?.status === 'number' ? err.status
        : fallback
  if (status >= 500) console.error('[galley] request failed:', error)
  send(res, status, { error: status === 404 ? 'not found' : (err?.message || String(error)) })
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buffer.byteLength
    if (size > limit) throw new HttpError(413, 'request body too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}
