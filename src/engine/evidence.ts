// Evidence comes from Canary: its search runtime finds the works, and galley
// reads their abstracts as the passages claims rest on. Bibliographic records
// come from the DOI registries, so every reference is the publisher's own.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Work } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(HERE, 'assets', 'canary_search.py')

/** Canary's own interpreter, so its runtime and settings are the ones used. */
export function canaryPython(): string {
  return process.env.GALLEY_CANARY_PYTHON || join(homedir(), '.local/share/uv/tools/canary/bin/python3')
}

export interface SearchQuery {
  id: string
  search: string
}

export interface SearchHit {
  id: string
  doi: string | null
  title: string
  year: number | null
  venue: string | null
  type: string | null
  authors: string[]
  abstract: string
  oa: boolean | null
  url: string | null
}

export interface QueryResult {
  matched: number | null
  status: number | null
  results: SearchHit[]
}

/**
 * The index cannot answer now. Unlike a model's usage limit, this never pauses
 * the paper: the search is an improver, so its step is given up and its claims
 * are stated as hypotheses.
 */
export class SourceUnavailable extends Error {}

/** How long galley waits out an index outage, across all its searches, before they give up and their claims are hedged. */
export const OUTAGE_PATIENCE_MS = 3 * 3600_000
/** When the index stopped answering; shared by every search in this process and cleared by any progress. */
let outageSince: number | null = null

/** With some results in hand, how long the rest of a batch is waited for once nothing more comes back. */
const PARTIAL_PATIENCE_MS = 30 * 60_000

/** The wait before the next pass: exactly what the index asked for, else a backoff that grows while nothing comes back; at most five minutes. */
export function searchWait(stalls: number, retryInMs: number): number {
  return Math.min(5 * 60_000, retryInMs > 0 ? retryInMs + 1_000 : 30_000 * 2 ** Math.min(stalls, 4))
}
const KEY_HINT = 'OpenAlex has no API key here; add OPENALEX_API_KEY=… to ~/.env (a free key from openalex.org) so searches are not limited'

interface SidecarReply {
  progress: string
  retry_not_before: number | null
  queries: Record<string, QueryResult & { done: boolean }>
}

/**
 * Canary discovery for a batch of queries, in one workspace. Canary keeps the
 * queries that finished and resumes the rest, so each pass only asks for what
 * is missing; between passes it waits as long as the index asked.
 */
export async function canarySearch(workspace: string, question: string, queries: SearchQuery[], top = 15, onWait?: (ms: number, why: string) => void, patienceMs = OUTAGE_PATIENCE_MS): Promise<Record<string, QueryResult>> {
  if (!queries.length) return {}
  let best = 0
  let stalls = 0
  let lastProgress = Date.now()
  for (let pass = 0; ; pass++) {
    // Canary stops a pass at the first query the index throttles; starting each pass at a different query keeps one refused query from starving the rest.
    const order = queries.map((_, i) => queries[(i + pass) % queries.length])
    // A workspace per search string, so a query is never answered with another query's results.
    const reply = await canarySearchOnce(question, order.map((q) => ({ ...q, workspace: join(workspace, `${q.id}-${createHash('sha256').update(q.search).digest('hex').slice(0, 8)}`) })), top)
    const pending = queries.filter((q) => !reply.queries[q.id]?.done)
    const found = queries.length - pending.length
    if (!pending.length) { outageSince = null; return reply.queries }
    const now = Date.now()
    if (found > best) { best = found; stalls = 0; outageSince = null; lastProgress = now } else stalls++
    outageSince ??= now
    const retryIn = reply.retry_not_before ? reply.retry_not_before * 1000 - now : 0
    // With results in hand the rest get half an hour; with none, an outage is waited out for hours. A spent daily budget that returns only after that is not waited for at all.
    const waitedEnough = found ? now - lastProgress > PARTIAL_PATIENCE_MS : now - outageSince > patienceMs
    if (waitedEnough || now + retryIn > outageSince + patienceMs) {
      if (found) return reply.queries
      throw new SourceUnavailable(`OpenAlex search is unavailable (${pending.length} queries pending, ${retryIn > 0 ? `next allowed in ${Math.round(retryIn / 60_000)} min` : `no answer for ${Math.round((now - outageSince) / 60_000)} min`}). ${KEY_HINT}`)
    }
    const wait = searchWait(stalls, retryIn)
    onWait?.(wait, `${found} of ${queries.length} queries done; OpenAlex asked to wait`)
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

async function canarySearchOnce(question: string, items: (SearchQuery & { workspace: string })[], top: number): Promise<SidecarReply> {
  if (!existsSync(canaryPython())) throw new Error(`Canary is not installed (no ${canaryPython()}); install it with uv tool install`)
  for (const item of items) mkdirSync(item.workspace, { recursive: true })
  const input = JSON.stringify({ question, items, top })
  const out = await new Promise<string>((resolve, reject) => {
    // Canary reads its key from OPENALEX_API_KEY, so a key kept in ~/.env reaches it this way.
    const key = openalexKey()
    const child = spawn(canaryPython(), ['-I', SIDECAR], { stdio: ['pipe', 'pipe', 'pipe'], env: key ? { ...process.env, OPENALEX_API_KEY: key } : process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Canary search failed (exit ${code}): ${stderr.slice(-800)}`)))
    child.stdin.end(input)
  })
  return JSON.parse(out) as SidecarReply
}

export function workFromHit(hit: SearchHit): Work {
  return {
    id: hit.id,
    doi: hit.doi ? hit.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() : null,
    title: hit.title,
    authors: hit.authors.filter(Boolean),
    year: hit.year,
    venue: hit.venue,
    abstract: hit.abstract,
    citedBy: null,
    url: hit.url,
  }
}

const UA = process.env.GALLEY_USER_AGENT || 'scholarly-client/0.1'

/**
 * The OpenAlex key, wherever the person keeps it: the environment, ~/.env, or
 * Canary's own settings file (OPENALEX_API_KEY in any case). Only that one
 * line is read; nothing else in those files is touched.
 */
export function openalexKey(): string | null {
  if (process.env.OPENALEX_API_KEY) return process.env.OPENALEX_API_KEY
  for (const file of [join(homedir(), '.env'), join(homedir(), '.local/share/canary/.env')]) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const value = line.match(/^\s*(?:export\s+)?openalex_api_key\s*=\s*(.*)$/i)?.[1].replace(/["'\s]/g, '')
      if (value) return value
    }
  }
  return null
}

/** Whether Canary searches OpenAlex with an API key. */
export const openalexKeyed = (): boolean => !!openalexKey()

/** A search costs this many OpenAlex credits, whatever its page size. */
export const SEARCH_CREDITS = 10

/** The keyless daily OpenAlex budget as it stands, read from a lookup that costs nothing. */
export async function openalexBudget(): Promise<{ remaining: number; limit: number; resetSeconds: number } | null> {
  try {
    const response = await fetch('https://api.openalex.org/works/W2741809807', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) })
    const value = (name: string) => Number(response.headers.get(name))
    if (!response.headers.get('x-ratelimit-limit')) return null
    return { remaining: value('x-ratelimit-remaining'), limit: value('x-ratelimit-limit'), resetSeconds: value('x-ratelimit-reset') }
  } catch {
    return null
  }
}

/** One line on what today's keyless budget allows, for doctor and the start of a run. */
export function budgetLine(budget: { remaining: number; limit: number; resetSeconds: number }): string {
  return `OpenAlex has no API key here: ${budget.remaining} of ${budget.limit} credits left today, about ${Math.floor(budget.remaining / SEARCH_CREDITS)} searches (a paper uses about 20 without a key), resetting in ${(budget.resetSeconds / 3600).toFixed(1)} h. A free key gives ten times that: add OPENALEX_API_KEY=… to ~/.env.`
}

/** The registry's CSL-JSON record for a DOI (Crossref and DataCite alike), or null. */
export async function cslForDoi(doi: string): Promise<Record<string, unknown> | null> {
  const url = `https://doi.org/${encodeURIComponent(doi).replace(/%2F/g, '/')}`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/vnd.citationstyles.csl+json', 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (response.status === 404) return null
      if (!response.ok) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue }
      return (await response.json()) as Record<string, unknown>
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  return null
}

/** Registries sometimes list an affiliation as an author ("Department of …, … University"). */
const ORGANIZATION = /\b(department|university|universit[äéà]t?|institute|institut|school|faculty|laborator(y|ies)|centre|center|college|hospital|academy|ministry|council|association|society|consortium)\b/i

const CSL_STRINGS = ['type', 'title', 'container-title', 'container-title-short', 'collection-title', 'event-title', 'volume', 'issue', 'page', 'number', 'DOI', 'URL', 'publisher', 'publisher-place', 'ISSN', 'ISBN', 'genre', 'language']
const CSL_NAMES = ['author', 'editor']

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Registries sometimes ship HTML entities inside titles ("Scientometrics &amp; Informetrics"). */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
}

/** Keep only standard CSL variables in their standard shapes: registries add lists and extras that citation processors reject. */
export function cleanCsl(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of CSL_STRINGS) {
    const value = raw[key]
    const text = Array.isArray(value) ? value.find((v) => typeof v === 'string' && v.trim()) : value
    if (typeof text === 'string' && text.trim()) out[key] = decodeEntities(text.replace(/<[^>]+>/g, '')).trim()
    else if (typeof text === 'number') out[key] = String(text)
  }
  for (const key of CSL_NAMES) {
    const value = raw[key]
    if (!Array.isArray(value)) continue
    const names = value.filter((n) => n && typeof n === 'object').map((n: any) => {
      const name: Record<string, string> = {}
      for (const part of ['family', 'given', 'literal', 'suffix', 'non-dropping-particle', 'dropping-particle']) if (typeof n[part] === 'string') name[part] = n[part]
      if (!name.family && !name.literal && typeof n.name === 'string') name.literal = n.name
      return name
    }).filter((n) => n.family || n.literal)
    // Keep an organization as an author only when no person is listed.
    const isOrganization = (n: Record<string, string>) => !n.given && ORGANIZATION.test(n.literal ?? n.family ?? '')
    const people = names.filter((n) => !isOrganization(n))
    const kept = people.length ? people : names
    if (kept.length) out[key] = kept
  }
  for (const key of ['issued', 'published', 'published-print', 'published-online', 'created']) {
    const parts = (raw[key] as any)?.['date-parts']
    if (Array.isArray(parts) && Array.isArray(parts[0]) && typeof parts[0][0] === 'number') {
      out.issued = { 'date-parts': [parts[0].filter((x: unknown) => typeof x === 'number').slice(0, 3)] }
      break
    }
  }
  // Registries name types their own way; citation styles expect CSL's names.
  const types: Record<string, string> = { 'journal-article': 'article-journal', 'proceedings-article': 'paper-conference', 'book-chapter': 'chapter', 'posted-content': 'article', dissertation: 'thesis', 'reference-entry': 'entry', 'monograph': 'book', 'edited-book': 'book' }
  out.type = types[String(out.type)] ?? (out.type || 'article-journal')
  return out
}

/** A CSL record from what the search knew, for works without a registered DOI. */
export function cslFromWork(work: Work): Record<string, unknown> {
  return {
    type: 'article-journal',
    title: work.title,
    author: work.authors.map((name) => {
      const parts = name.trim().split(/\s+/)
      return parts.length > 1 ? { family: parts.pop(), given: parts.join(' ') } : { literal: name }
    }),
    issued: work.year ? { 'date-parts': [[work.year]] } : undefined,
    'container-title': work.venue ?? undefined,
    URL: work.url ?? undefined,
  }
}

/** Run a short command and return its stdout (used for tool checks). */
export function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120_000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)))
}
