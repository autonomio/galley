// A store that speaks Galley's HTTP protocol (src/server/http.ts):
//
//   GET    {base}/docs                     → { docs }
//   POST   {base}/docs                     → DocWriteResult (new blank doc)
//   GET    {base}/doc/:slug                → DocRead
//   PUT    {base}/doc/:slug                → DocWriteResult | 409 { error, current_version }
//   DELETE {base}/doc/:slug                → { ok: true }
//   GET    {base}/doc/:slug/annotations    → { annotations, version }
//   PUT    {base}/doc/:slug/annotations    → { ok, version, stale? } | 409
//
// Writes carry { client_id, revision, base_version }. POST is accepted as
// an alias of both PUTs, because navigator.sendBeacon can only POST.
import { ConflictError } from '../core/errors.js'
import type { Annotation, AnnotationsRead, AnnotationsWriteResult, DocRead, DocSummary, DocWriteResult, WriteContext } from '../types.js'
import type { DocumentStore, UnloadSave } from './types.js'

export interface HttpStoreOptions {
  /** Where the protocol is mounted. Default `/api/galley`. */
  baseUrl?: string
  /** Extra headers for every request, e.g. authorization. Beacons cannot carry them. */
  headers?: Record<string, string> | (() => Record<string, string>)
  fetch?: typeof fetch
}

export function createHttpStore(options: HttpStoreOptions = {}): DocumentStore {
  const base = (options.baseUrl ?? '/api/galley').replace(/\/+$/, '')
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const headers = (): Record<string, string> =>
    typeof options.headers === 'function' ? options.headers() : { ...(options.headers ?? {}) }
  const docUrl = (slug: string) => `${base}/doc/${encodeURIComponent(slug)}`

  async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await doFetch(url, { ...init, headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) } })
    if (!res.ok) await throwFor(res)
    return await res.json() as T
  }

  function body(payload: unknown): RequestInit {
    return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  }

  return {
    async list(): Promise<DocSummary[]> {
      const data = await request<{ docs?: unknown }>(`${base}/docs`)
      if (!Array.isArray(data.docs)) throw new Error('Malformed document list')
      return data.docs as DocSummary[]
    },
    async create(): Promise<DocWriteResult> {
      const data = await request<DocWriteResult>(`${base}/docs`, { method: 'POST' })
      if (!data || typeof data.slug !== 'string' || !data.slug) throw new Error('Malformed create response')
      return data
    },
    async read(slug: string): Promise<DocRead> {
      const data = await request<DocRead>(docUrl(slug))
      if (typeof data.content !== 'string' || !isVersion(data.version)) throw new Error('Malformed document response')
      return data
    },
    async write(slug: string, content: string, context: WriteContext): Promise<DocWriteResult> {
      const data = await request<DocWriteResult>(docUrl(slug), body(documentPayload(content, context)))
      if (!isVersion(data.version)) throw new Error('Save response omitted the document version')
      return data
    },
    async remove(slug: string): Promise<void> {
      await request(docUrl(slug), { method: 'DELETE' })
    },
    async readAnnotations(slug: string): Promise<AnnotationsRead> {
      const data = await request<AnnotationsRead>(`${docUrl(slug)}/annotations`)
      if (!Array.isArray(data.annotations) || !isVersion(data.version)) throw new Error('Malformed annotations response')
      return data
    },
    async writeAnnotations(slug: string, annotations: Annotation[], context: WriteContext): Promise<AnnotationsWriteResult> {
      const data = await request<AnnotationsWriteResult>(`${docUrl(slug)}/annotations`, body(annotationsPayload(annotations, context)))
      if (!isVersion(data.version)) throw new Error('Save response omitted the annotations version')
      return data
    },
    beacon(save: UnloadSave): boolean {
      if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false
      const [url, payload] = save.kind === 'document'
        ? [docUrl(save.slug), documentPayload(save.content, save.context)]
        : [`${docUrl(save.slug)}/annotations`, annotationsPayload(save.annotations, save.context)]
      try {
        return navigator.sendBeacon(url, new Blob([JSON.stringify(payload)], { type: 'application/json' }))
      } catch {
        return false
      }
    },
  }
}

function documentPayload(content: string, context: WriteContext) {
  return { content, client_id: context.clientId, revision: context.revision, base_version: context.baseVersion }
}

function annotationsPayload(annotations: Annotation[], context: WriteContext) {
  return { annotations, client_id: context.clientId, revision: context.revision, base_version: context.baseVersion }
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

async function throwFor(res: Response): Promise<never> {
  let message = `HTTP ${res.status}`
  let current: unknown
  try {
    const data = await res.json() as { error?: unknown, current_version?: unknown }
    if (typeof data.error === 'string' && data.error) message = data.error
    current = data.current_version
  } catch { /* keep the status fallback */ }
  if (res.status === 409) throw new ConflictError(typeof current === 'string' ? current : '', message)
  const error = new Error(message) as Error & { status?: number }
  error.status = res.status
  throw error
}
