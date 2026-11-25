// Evidence comes from Canary: its search runtime finds the works, and galley
// reads their abstracts as the passages claims rest on. Bibliographic records
// come from the DOI registries, so every reference is the publisher's own.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { personNames } from './text.js'
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
    authors: personNames(hit.authors.filter(Boolean)),
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
export const titleWords = (title: string) => title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** What the index returns for a work searched by its title. */
interface IndexRecord {
  doi?: string
  display_name?: string
  publication_year?: number
  type?: string
  cited_by_count?: number
  authorships?: { author?: { display_name?: string }; institutions?: { display_name?: string }[] }[]
  primary_location?: { landing_page_url?: string; source?: { display_name?: string } }
}

/** The index's kinds of work, as CSL names them; a kind it shares with a journal article says nothing and is left out. */
const INDEX_TYPES: Record<string, string> = { dissertation: 'thesis', book: 'book', 'book-chapter': 'chapter', report: 'report', preprint: 'article', dataset: 'dataset', standard: 'standard' }

/** A name to compare: lower case, without accents. */
const plainName = (name: string) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * A work known only by its title and year (a reference that would print as a title, a year and a link) completed from
 * OpenAlex: its DOI, authors and venue, taken only from a record whose title is the same word for word and whose year
 * is within one, or whose first author is the work's. One search; the work keeps what it had when nothing matches or
 * the index cannot answer.
 */
export async function completeByTitle(work: Work, replace = false): Promise<boolean> {
  const words = titleWords(work.title)
  if (words.length < 3 || work.doi) return false
  try {
    const key = openalexKey()
    const response = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(work.title)}&per_page=8&select=doi,display_name,publication_year,type,cited_by_count,authorships,primary_location${key ? `&api_key=${encodeURIComponent(key)}` : ''}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return false
    const { results = [] } = await response.json() as { results?: IndexRecord[] }
    // The same title, and of those the one nearest the year the work gives. A document found on the web (`replace`)
    // may carry the date it was posted or read rather than published, so its year only ranks the matches. The same
    // title by the same first author is the work whatever year the index dates it by: its journal version, a reprint
    // or a translation is often dated after it.
    const near = (r: IndexRecord) => (work.year && r.publication_year ? Math.abs(r.publication_year - work.year) : 0)
    const first = work.authors[0] ? plainName(work.authors[0].trim().split(/\s+/).pop() ?? '') : ''
    const byFirst = (r: IndexRecord) => first.length > 1 && (r.authorships ?? []).some((a) => plainName(a.author?.display_name ?? '').split(/[\s-]+/).includes(first))
    // Of the records that are the work, the one that says where it was published: a DOI first, then the most cited,
    // so the work's main record and not a stub of it that the index also keeps.
    const same = results
      .filter((r) => titleWords(r.display_name ?? '').join(' ') === words.join(' ') && (replace || near(r) <= 1 || byFirst(r)))
      .sort((a, b) => (b.doi ? 1 : 0) - (a.doi ? 1 : 0) || (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0) || near(a) - near(b))[0]
    if (!same) return false
    work.doi = same.doi ? same.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() : null
    const authors = personNames((same.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean))
    if (authors.length) work.authors = authors
    // A web document's issuer and date give way to the publication's own record.
    work.year = replace ? same.publication_year ?? work.year : work.year ?? same.publication_year ?? null
    work.venue = replace ? same.primary_location?.source?.display_name ?? work.venue : work.venue ?? same.primary_location?.source?.display_name ?? null
    // Without a DOI record, what the index knows says what the work is and where it is found: its kind, the institution
    // its author wrote it at, and the page of whoever holds it rather than the index's own.
    if (!work.doi) {
      const kind = INDEX_TYPES[same.type ?? '']
      if (kind) work.kind = kind
      const institution = same.authorships?.[0]?.institutions?.[0]?.display_name
      if (institution) work.institution = institution
      const page = same.primary_location?.landing_page_url
      if (page && !/openalex\.org/i.test(page)) work.url = page
    }
    return true
  } catch {
    return false
  }
}

export async function cslForDoi(doi: string): Promise<Record<string, unknown> | null> {
  const url = `https://doi.org/${encodeURIComponent(doi).replace(/%2F/g, '/')}`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/vnd.citationstyles.csl+json', 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (response.status === 404) return null
      if (!response.ok) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue }
      const csl = (await response.json()) as Record<string, unknown>
      await fromRegistry(doi, csl)
      return csl
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  return null
}

/** The JSON a registry's own API returns for a record, or null. */
async function registryJson(url: string): Promise<any | null> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

/**
 * What a DOI's citation record folds away, taken from the record of the registry that issued it: the book a chapter is
 * in beside the series it belongs to, and for a paper in proceedings, the proceedings' own title, its series and
 * number, and its type. A record the registry cannot give is left as it came.
 */
export async function fromRegistry(doi: string, csl: Record<string, unknown>): Promise<void> {
  const id = encodeURIComponent(doi).replace(/%2F/g, '/')
  if (csl.source === 'Crossref') {
    const record = (await registryJson(`https://api.crossref.org/works/${id}`))?.message
    if (record) refineFromCrossref(csl, record)
  } else {
    const record = (await registryJson(`https://api.datacite.org/dois/${id}`))?.data?.attributes
    if (record) refineFromDatacite(csl, record)
  }
}

/** A chapter's Crossref record names the series first and the book second; the citation record keeps only the series. */
export function refineFromCrossref(csl: Record<string, unknown>, record: any): void {
  const titles = (Array.isArray(record?.['container-title']) ? record['container-title'] : []).filter((t: unknown) => typeof t === 'string' && t.trim())
  if (titles.length < 2 || !/chapter|proceedings-article|book-section|book-part|reference-entry|book-track/.test(String(record.type))) return
  csl['container-title'] = titles[titles.length - 1]
  csl['collection-title'] = titles[0]
  if (record.volume) {
    csl['collection-number'] = String(record.volume)
    delete csl.volume
  }
}

const DATACITE_TYPES: Record<string, string> = { ConferencePaper: 'paper-conference', JournalArticle: 'article-journal', Preprint: 'article', BookChapter: 'chapter', Book: 'book', ConferenceProceeding: 'book', Report: 'report', Dissertation: 'thesis', Dataset: 'dataset', Software: 'software', Standard: 'standard' }

/** A DataCite record says what a work is and what it was published in, with the series apart from the volume. */
export function refineFromDatacite(csl: Record<string, unknown>, record: any): void {
  const type = DATACITE_TYPES[String(record?.types?.resourceTypeGeneral)]
  if (type) csl.type = type
  for (const item of Array.isArray(record?.relatedItems) ? record.relatedItems : []) {
    if (item?.relationType !== 'IsPublishedIn') continue
    const titles: any[] = Array.isArray(item.titles) ? item.titles : []
    const main = titles.find((t) => t && !t.titleType)?.title
    const sub = titles.find((t) => t?.titleType === 'Subtitle')?.title
    if (['ConferenceProceeding', 'Book', 'Journal'].includes(item.relatedItemType)) {
      // A proceedings volume can carry its series and number as its title ("LIPIcs, Volume 102, CCC 2018") and its own
      // name as the subtitle.
      const name = sub && /\bvol(?:ume)?\.?\s*\d/i.test(String(main ?? '')) ? sub : [main, sub].filter(Boolean).join(': ')
      if (name) csl['container-title'] = name
      if (item.firstPage) csl.page = item.lastPage ? `${item.firstPage}-${item.lastPage}` : String(item.firstPage)
      if (item.relatedItemType === 'Journal' && item.volume) csl.volume = String(item.volume)
      if (item.relatedItemType === 'Journal' && item.issue) csl.issue = String(item.issue)
    } else if (['Collection', 'BookSeries', 'Series'].includes(item.relatedItemType) && main) {
      csl['collection-title'] = main
      if (item.volume) csl['collection-number'] = String(item.volume)
    }
  }
  // The series number is the series': it is not also the volume of the proceedings.
  if (csl['collection-number'] && String(csl.volume ?? '') === String(csl['collection-number'])) delete csl.volume
  // A paper's number within the proceedings or book it is in locates it there, as its pages do; the reference names
  // the volume, as citation styles cite a chapter.
  if (csl.type === 'paper-conference' || csl.type === 'chapter') delete csl.number
}

/** Registries sometimes list an affiliation as an author ("Department of …, … University"). */
const ORGANIZATION = /\b(department|university|universit[äéà]t?|institute|institut|school|faculty|laborator(y|ies)|centre|center|college|hospital|academy|ministry|council|association|society|consortium)\b/i

const CSL_STRINGS = ['type', 'title', 'container-title', 'container-title-short', 'collection-title', 'collection-number', 'event-title', 'volume', 'issue', 'page', 'number', 'DOI', 'URL', 'publisher', 'publisher-place', 'ISSN', 'ISBN', 'genre', 'language']
const CSL_NAMES = ['author', 'editor']

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Registries sometimes ship HTML entities inside titles ("Scientometrics &amp; Informetrics"). */
function decodeEntities(text: string): string {
  // A registry can encode an entity twice ("I&amp;amp;CPS"): it is decoded until nothing is left to decode.
  for (let pass = 0; pass < 3; pass++) {
    const next = text
      .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    if (next === text) break
    text = next
  }
  return text
}

/** TeX a title carries: Greek letters, relations and operators by name, as the characters they print. */
const TEX_CHARACTERS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', ell: 'ℓ',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', sim: '∼', simeq: '≃', equiv: '≡', propto: '∝', times: '×', cdot: '·', pm: '±', mp: '∓', infty: '∞',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', to: '→', rightarrow: '→', leftarrow: '←', mapsto: '↦', Rightarrow: '⇒',
  ldots: '…', dots: '…', cdots: '⋯', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', neg: '¬', lnot: '¬', wedge: '∧', land: '∧', vee: '∨', lor: '∨', oplus: '⊕', otimes: '⊗',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', mid: '∣', star: '⋆', ast: '∗', circ: '∘', sum: '∑', prod: '∏', int: '∫',
  ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', quad: ' ', qquad: ' ', '{': '{', '}': '}', '%': '%', '&': '&', '_': '_', '#': '#', '$': '$', '|': '‖',
}
/** Operators a formula prints upright, by their names. */
const TEX_OPERATORS = new Set(['log', 'ln', 'lg', 'exp', 'min', 'max', 'sup', 'inf', 'lim', 'liminf', 'limsup', 'sin', 'cos', 'tan', 'det', 'dim', 'deg', 'gcd', 'Pr', 'arg', 'poly', 'polylog'])
/** Accents, as the combining marks that put them over the letter. */
const TEX_ACCENTS: Record<string, string> = { tilde: '̃', widetilde: '̃', hat: '̂', widehat: '̂', bar: '̄', overline: '̅', vec: '⃗', dot: '̇', ddot: '̈', check: '̌' }
/** Commands that set what they enclose upright, and those that set it in italics. */
const TEX_UPRIGHT = new Set(['mathrm', 'text', 'textrm', 'textup', 'textnormal', 'operatorname', 'mathsf', 'textsf', 'mathtt', 'texttt', 'mathbf', 'textbf', 'boldsymbol', 'bm', 'mathbb', 'mathcal', 'mathfrak', 'mathscr'])
const TEX_ITALIC = new Set(['mathit', 'textit', 'emph'])
/** Commands that only size or space what follows: they print nothing themselves. */
const TEX_SILENT = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr', 'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits'])

/** A formula in TeX as the rich text a citation style prints: letters in italics, exponents and indices raised and lowered. */
function texMath(math: string): string {
  let i = 0
  const plain = (text: string) => text.replace(/<\/?i>/g, '')
  const group = (): string => {
    while (math[i] === ' ') i++
    if (math[i] !== '{') return atom()
    let depth = 0
    let j = i
    for (; j < math.length; j++) {
      if (math[j] === '{') depth++
      else if (math[j] === '}' && --depth === 0) break
    }
    const inner = math.slice(i + 1, j)
    i = j + 1
    return texMath(inner)
  }
  const atom = (): string => {
    const ch = math[i]
    if (ch === undefined) return ''
    if (ch === '{') return group()
    i++
    if (ch === '\\') {
      const name = math.slice(i).match(/^(?:[a-zA-Z]+|.)/)?.[0] ?? ''
      i += name.length
      if (name in TEX_CHARACTERS) return TEX_CHARACTERS[name]
      if (TEX_OPERATORS.has(name)) return ` ${name}${/^\s*[A-Za-z0-9\\]/.test(math.slice(i)) ? ' ' : ''}`
      if (name in TEX_ACCENTS) return `<i>${plain(group())}${TEX_ACCENTS[name]}</i>`.normalize('NFC')
      if (TEX_UPRIGHT.has(name)) return plain(group())
      if (TEX_ITALIC.has(name)) return `<i>${plain(group())}</i>`
      if (TEX_SILENT.has(name)) return ''
      if (name === 'sqrt') {
        const inner = group()
        return `√${inner.replace(/<[^>]+>/g, '').length > 1 ? `(${inner})` : inner}`
      }
      if (/^[dt]?frac$/.test(name)) {
        const over = group()
        return `${over}/${group()}`
      }
      // An unknown command prints its name, never its backslash.
      return name
    }
    if (ch === '^') return `<sup>${group()}</sup>`
    if (ch === '_') return `<sub>${group()}</sub>`
    if (ch === '}' || ch === ' ') return ''
    if (ch === '~') return ' '
    if (ch === '-') return '−'
    if (ch === "'") return '′'
    return /[A-Za-z]/.test(ch) ? `<i>${ch}</i>` : ch
  }
  const out: string[] = []
  while (i < math.length) out.push(atom())
  return out.join('').replace(/<\/i><i>/g, '').replace(/<\/sup><sup>/g, '').replace(/<\/sub><sub>/g, '')
    .replace(/ {2,}/g, ' ').replace(/([([{]|<su[bp]>) /g, '$1').trim()
}

/**
 * A title's TeX ("for $k$-Sparse Parity", "$\tilde{O}(d^{k-1})$ Samples") as what it prints, never as code. A formula
 * is marked as Pandoc marks one: its opening $ followed by a character, its closing $ preceded by one and not followed
 * by a digit, so prices ("a $5 fee and $3 tax") stay as they are.
 */
export function texToCsl(text: string): string {
  return text.replace(/\$\$([^$]+)\$\$|\$(?=\S)([^$\n]*?\S)\$(?!\d)|\\\(([\s\S]+?)\\\)/g, (_, display: string | undefined, inline: string | undefined, paren: string | undefined) => texMath(display ?? inline ?? paren ?? ''))
}

/** A name written all in capitals, with at least this many letters in a word. */
export const shouting = (name: string, letters: number) => name === name.toUpperCase() && name !== name.toLowerCase() && new RegExp(`\\p{L}{${letters},}`, 'u').test(name)

/** A capitalized name in name case: each word, and each part after a hyphen or apostrophe, starts with a capital. */
export const nameCase = (name: string) => name.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase())

/** A title without the footnote mark a publisher's page put after it, pointing to a note no reference carries. */
export const bareTitle = (title: string) => title.replace(/\s*[†‡§¶]+$/u, '').trim()

/** Keep only standard CSL variables in their standard shapes: registries add lists and extras that citation processors reject. */
export function cleanCsl(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of CSL_STRINGS) {
    const value = raw[key]
    const text = Array.isArray(value) ? value.find((v) => typeof v === 'string' && v.trim()) : value
    // Registries keep a title's markup line breaks as runs of white space.
    if (typeof text === 'string' && text.trim()) out[key] = decodeEntities(text.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    else if (typeof text === 'number') out[key] = String(text)
  }
  if (typeof out.title === 'string') out.title = bareTitle(out.title)
  // A title with a subtitle prints whole ("Pebbles, Graphs, and a Pinch of Combinatorics: Towards Tight I/O Lower Bounds").
  const subtitle = Array.isArray(raw.subtitle) ? raw.subtitle.find((v) => typeof v === 'string' && v.trim()) : raw.subtitle
  if (typeof subtitle === 'string' && subtitle.trim() && typeof out.title === 'string') {
    const sub = decodeEntities(subtitle.replace(/<[^>]+>/g, '')).trim()
    if (!out.title.toLowerCase().includes(sub.toLowerCase())) out.title = `${out.title}${/[?!:.]$/.test(out.title) ? ' ' : ': '}${sub}`
  }
  // A formula in a title prints as the formula, not as the TeX a registry keeps it in.
  for (const key of ['title', 'container-title', 'collection-title']) if (typeof out[key] === 'string') out[key] = texToCsl(out[key] as string)
  for (const key of CSL_NAMES) {
    const value = raw[key]
    if (!Array.isArray(value)) continue
    const names = value.filter((n) => n && typeof n === 'object').map((n: any) => {
      const name: Record<string, string> = {}
      for (const part of ['family', 'given', 'literal', 'suffix', 'non-dropping-particle', 'dropping-particle']) if (typeof n[part] === 'string') name[part] = n[part]
      if (!name.family && !name.literal && typeof n.name === 'string') name.literal = n.name
      // A person's name some registries keep in capitals (ZIRAS) prints as the name (Ziras); initials stay as they are.
      if (name.family && shouting(name.family, 2)) name.family = nameCase(name.family)
      if (name.given && shouting(name.given, 3)) name.given = nameCase(name.given)
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
  // A thesis has one author: an index that lists more lists its advisers with them.
  if (out.type === 'thesis' && Array.isArray(out.author) && out.author.length > 1) out.author = out.author.slice(0, 1)
  // A paper in proceedings, a chapter or a book is dated by its year: the day of the conference is not part of it.
  const parts = (out.issued as { 'date-parts': number[][] } | undefined)?.['date-parts']?.[0]
  if (['paper-conference', 'chapter', 'book'].includes(String(out.type)) && parts && parts.length > 1) out.issued = { 'date-parts': [[parts[0]]] }
  // A preprint server is where a preprint was posted, not a journal it appeared in.
  if (/^10\.48550\//i.test(String(out.DOI ?? '')) || /^arxiv\b/i.test(String(out['container-title'] ?? '')) || /^arxiv$/i.test(String(out.publisher ?? ''))) {
    out.type = 'article'
    out.publisher = 'arXiv'
    delete out['container-title']
  }
  // A container title that already states the volume ("LIPIcs, Volume 102, CCC 2018") prints it once.
  const stated = String(out['container-title'] ?? '').match(/\bvol(?:ume)?\.?\s*(\d+)\b/i)
  if (stated && stated[1] === String(out.volume ?? '')) delete out.volume
  return out
}

/** A CSL record from what the search knew, for works without a registered DOI. */
export function cslFromWork(work: Work): Record<string, unknown> {
  return {
    type: work.kind ?? 'article-journal',
    title: work.title,
    author: personNames(work.authors).map((name) => {
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
