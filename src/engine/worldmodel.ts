// A world model as a paper's sources. A Resolvent repository holds claims, the
// evidence each rests on and the sources behind the evidence, each source with
// a verbatim excerpt. Given as a zip or a folder, it is read once into the
// paper's folder (world-model/world-model.json). From then on every search for
// sources (the positioning, and the evidence for each claim) searches it: by
// default only it, so the paper rests on nothing else; or the world model first
// and then the literature and the web. Each claim the paper makes is still
// checked against a source's own passage by a family that did not propose it.
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ensureAnalysisEnv } from './analysis.js'
import { completeByTitle, cslForDoi, openalexKey, type QueryResult, type SearchHit } from './evidence.js'
import type { Paper } from './paper.js'
import { personNames } from './text.js'
import type { Work } from './types.js'

export interface ModelClaim { id: string; statement: string; uncertainty?: string; class?: string; evidence_ids?: string[]; state?: string }
export interface ModelEvidence { id: string; kind?: string; summary?: string; source_ids?: string[]; independent?: boolean; limitations?: string[]; claim_ids?: string[]; premise_claim_ids?: string[] }
export interface ModelSource { id: string; kind?: string; title?: string; uri?: string; date?: string; excerpt?: string; access?: string; openalex?: string }
export interface ModelRelation { id: string; from?: string; to?: string; type?: string; reason?: string }

/** A world model as galley keeps it: its records, read once, with where they came from. */
export interface WorldModel {
  name: string
  sha256: string
  claims: ModelClaim[]
  evidence: ModelEvidence[]
  sources: ModelSource[]
  graph: ModelRelation[]
}

/** What a paper's config says about its world model. */
export interface WorldModelConfig {
  name: string
  /** The world model's records, relative to the paper's folder. */
  file: string
  /** Only the world model's sources (the default), or the world model first and then the literature and the web. */
  only: boolean
  sha256: string
  claims: number
  evidence: number
  sources: number
}

/** The folder of a Resolvent repository: the one holding claims/ and sources/, the given folder or one inside it. */
export function worldModelRoot(dir: string, depth = 2): string | null {
  if (existsSync(join(dir, 'claims')) && existsSync(join(dir, 'sources'))) return dir
  if (depth === 0) return null
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === '__MACOSX') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      const found = worldModelRoot(path, depth - 1)
      if (found) return found
    }
  }
  return null
}

const exec = (cmd: string, args: string[], timeout = 900_000) => new Promise<string>((resolve, reject) =>
  execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim().split('\n').slice(-3).join(' '))) : resolve(stdout)))

/**
 * A Python that reads YAML exactly as Resolvent writes it (PyYAML's safe loader): galley's own analysis environment,
 * with PyYAML added on first use.
 */
async function yamlPython(): Promise<string> {
  const python = await ensureAnalysisEnv()
  if (!python) throw new Error('a world model is read with Python and PyYAML, and galley could not make its Python environment (install uv)')
  try { await exec(python, ['-I', '-c', 'import yaml']); return python } catch { /* added below */ }
  const uv = ['uv', join(homedir(), '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv'].find((u) => { try { execFileSync(u, ['--version'], { stdio: 'ignore' }); return true } catch { return false } })
  if (uv) await exec(uv, ['pip', 'install', '--python', python, '--quiet', 'pyyaml'])
  else await exec(python, ['-m', 'pip', 'install', '--quiet', 'pyyaml'])
  return python
}

// Reads only the YAML records, with the safe loader; nothing in the repository runs.
const READ = `
import json, os, sys, yaml
root, out = sys.argv[1], sys.argv[2]
model = {}
for folder in ('claims', 'evidence', 'sources', 'graph'):
    items = []
    path = os.path.join(root, folder)
    for name in sorted(os.listdir(path)) if os.path.isdir(path) else []:
        if not name.endswith(('.yaml', '.yml')):
            continue
        try:
            with open(os.path.join(path, name), encoding='utf-8') as f:
                record = yaml.safe_load(f)
        except Exception:
            continue
        if isinstance(record, dict) and record.get('id'):
            items.append(record)
    model[folder] = items
with open(out, 'w', encoding='utf-8') as f:
    json.dump(model, f, ensure_ascii=False, default=str)
`

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim()
const strs = (v: unknown) => Array.isArray(v) ? v.map(str).filter(Boolean) : []
/** The OpenAlex record a source's locator names, when the passage came from a research bundle that names it. */
const openalexOf = (locator: unknown) => {
  try {
    const l = typeof locator === 'string' ? JSON.parse(locator) : locator as Record<string, unknown> | null
    const id = String(l?.paper_metadata_id ?? l?.reference_id ?? '')
    return /^W\d+$/.test(id) ? id : undefined
  } catch { return undefined }
}

/** A world model's name from where it came: its folder, or the zip GitHub makes of it (repo-main), without the branch. */
export function worldModelName(path: string): string {
  return basename(path).replace(/\.zip$/i, '').replace(/-(main|master|[0-9a-f]{7,40})$/i, '') || 'world model'
}

/** Read a Resolvent repository (a zip, or a folder) into galley's form: only what a paper uses, nothing that runs. */
export async function readWorldModel(path: string, name = worldModelName(path)): Promise<WorldModel> {
  const isZip = /\.zip$/i.test(path) && statSync(path).isFile()
  const work = mkdtempSync(join(tmpdir(), 'galley-world-model-'))
  try {
    let root: string | null = path
    if (isZip) {
      const unpacked = join(work, 'unpacked')
      mkdirSync(unpacked)
      // Only the records are taken out of the zip.
      // unzip exits non-zero when one of the patterns matches nothing; only an archive it could not read is an error,
      // said without the server's paths.
      await exec('unzip', ['-q', '-o', path, '*/claims/*', '*/evidence/*', '*/sources/*', '*/graph/*', 'claims/*', 'evidence/*', 'sources/*', 'graph/*', '-d', unpacked]).catch(() => {
        if (!readdirSync(unpacked).length) throw new Error(`${name} is not a zip archive galley can unpack, or it holds no claims/ and sources/ folders`)
      })
      root = worldModelRoot(unpacked)
    } else root = worldModelRoot(path)
    if (!root) throw new Error(`${name} is not a Resolvent world model: it has no claims/ and sources/ folders`)
    const out = join(work, 'model.json')
    await exec(await yamlPython(), ['-I', '-c', READ, root, out])
    const raw = JSON.parse(readFileSync(out, 'utf8')) as Record<string, Record<string, unknown>[]>
    const sha256 = isZip ? createHash('sha256').update(readFileSync(path)).digest('hex') : createHash('sha256').update(readFileSync(out)).digest('hex')
    return {
      name, sha256,
      claims: (raw.claims ?? []).map((c) => ({ id: str(c.id), statement: str(c.statement), uncertainty: str(c.uncertainty) || undefined, class: str(c.class) || undefined, evidence_ids: strs(c.evidence_ids), state: str(c.state) || undefined })).filter((c) => c.statement),
      evidence: (raw.evidence ?? []).map((e) => ({ id: str(e.id), kind: str(e.kind) || undefined, summary: str(e.summary) || undefined, source_ids: strs(e.source_ids), independent: e.independent === true, limitations: strs(e.limitations), claim_ids: strs(e.claim_ids), premise_claim_ids: strs(e.premise_claim_ids) })),
      // An excerpt keeps its own line breaks only as spaces: it is matched verbatim after the same squeeze.
      sources: (raw.sources ?? []).map((s) => ({ id: str(s.id), kind: str(s.kind) || undefined, title: str(s.title) || undefined, uri: str(s.uri) || undefined, date: str(s.date) || undefined, excerpt: str(s.excerpt) || undefined, access: str(s.access) || undefined, openalex: openalexOf(s.locator) })),
      graph: (raw.graph ?? []).map((r) => ({ id: str(r.id), from: str(r.from) || undefined, to: str(r.to) || undefined, type: str(r.type) || undefined, reason: str(r.reason) || undefined })),
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** A world model's records from a converted file (world-model.json), a zip, or a folder. */
export async function loadWorldModelFile(path: string, name?: string): Promise<WorldModel> {
  if (/\.json$/i.test(path)) return JSON.parse(readFileSync(path, 'utf8')) as WorldModel
  return readWorldModel(path, name || worldModelName(path))
}

const isActive = (c: ModelClaim) => !c.state || c.state === 'active'

/** What a world model holds, as the start dialog and the run log say it. */
export function worldModelSummary(model: WorldModel) {
  return { name: model.name, sha256: model.sha256, claims: model.claims.filter(isActive).length, evidence: model.evidence.length, sources: model.sources.filter((s) => s.excerpt).length, relations: model.graph.length }
}

/** Keep the world model in the paper's folder and say so in its config. */
export function keepWorldModel(dir: string, model: WorldModel, only: boolean): WorldModelConfig {
  const file = join('world-model', 'world-model.json')
  mkdirSync(join(dir, 'world-model'), { recursive: true })
  writeFileSync(join(dir, file), JSON.stringify(model))
  const s = worldModelSummary(model)
  return { name: s.name, file, only, sha256: s.sha256, claims: s.claims, evidence: s.evidence, sources: s.sources }
}

// ---------------------------------------------------------------- search

const STOP = new Set(('a an and are as at be been being but by can could do does for from had has have how if in into is it its ' +
  'may might more most no nor not of on or our such than that the their them then there these they this those through to ' +
  'under was we were what when where which while who why will with within without would').split(' '))

/** The words a search matches on: lower-case letters and digits, without the commonest words. */
export const words = (text: string) => (text.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t))

interface Indexed { id: string; tf: Map<string, number>; len: number }
interface Index { docs: Indexed[]; df: Map<string, number>; avg: number }

function indexOf(items: { id: string; text: string }[]): Index {
  const docs: Indexed[] = []
  const df = new Map<string, number>()
  for (const item of items) {
    const tf = new Map<string, number>()
    const list = words(item.text)
    for (const w of list) tf.set(w, (tf.get(w) ?? 0) + 1)
    for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1)
    docs.push({ id: item.id, tf, len: list.length })
  }
  return { docs, df, avg: docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length) }
}

/** BM25: the documents that share the query's rarer words most, with length taken into account. */
function rank(index: Index, query: string, top: number): { id: string; score: number }[] {
  const terms = [...new Set(words(query))]
  const n = index.docs.length
  const scored: { id: string; score: number }[] = []
  for (const d of index.docs) {
    let score = 0
    for (const t of terms) {
      const f = d.tf.get(t)
      if (!f) continue
      const df = index.df.get(t) ?? 0
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / index.avg))
    }
    if (score > 0) scored.push({ id: d.id, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, top)
}

/**
 * One publication of a world model. A world model keeps each passage it quotes as a source record of its own, so one
 * paper can be many sources; galley cites the paper once, with all its passages.
 */
export interface Publication { id: string; title: string; uri?: string; doi: string | null; year: number | null; kind?: string; openalex?: string; excerpts: { source: string; text: string }[] }

/** A world model ready to search: its sources by their excerpts and by the claims they support, and its claims. */
export interface SearchableModel {
  model: WorldModel
  sources: Map<string, ModelSource>
  publications: Map<string, Publication>
  publicationOf: Map<string, string>
  bySource: Index
  byClaim: Index
  claims: Map<string, ModelClaim>
  sourcesOf: Map<string, Set<string>>
}

/** The excerpts of one publication, joined so that no passage copied from one can run on into the next. */
export const JOIN = ' [...] '

const yearOf = (date: string | undefined) => { const y = Number(String(date ?? '').slice(0, 4)); return y > 1000 ? y : null }

function publicationsOf(sources: ModelSource[]): { publications: Map<string, Publication>; publicationOf: Map<string, string> } {
  const byKey = new Map<string, Publication>()
  const publicationOf = new Map<string, string>()
  for (const s of [...sources].sort((a, b) => a.id.localeCompare(b.id))) {
    const doi = doiOfUri(s.uri)
    const key = doi ?? (s.uri ? s.uri.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase() : `title:${(s.title ?? s.id).toLowerCase()}`)
    const p = byKey.get(key) ?? { id: s.id, title: s.title || s.id, uri: s.uri, doi, year: yearOf(s.date), kind: s.kind, openalex: s.openalex, excerpts: [] }
    p.excerpts.push({ source: s.id, text: s.excerpt ?? '' })
    p.year ??= yearOf(s.date)
    p.openalex ??= s.openalex
    byKey.set(key, p)
    publicationOf.set(s.id, p.id)
  }
  return { publications: new Map([...byKey.values()].map((p) => [p.id, p])), publicationOf }
}

export function searchable(model: WorldModel): SearchableModel {
  const claims = new Map(model.claims.filter(isActive).map((c) => [c.id, c]))
  const evidence = new Map(model.evidence.map((e) => [e.id, e]))
  // What each source is evidence for: the claims that cite its evidence, and the evidence's own summary.
  const about = new Map<string, string[]>()
  const sourcesOf = new Map<string, Set<string>>()
  for (const c of claims.values()) {
    for (const id of c.evidence_ids ?? []) {
      const e = evidence.get(id)
      for (const s of e?.source_ids ?? []) {
        about.set(s, [...(about.get(s) ?? []), c.statement, e?.summary ?? ''])
        sourcesOf.set(c.id, (sourcesOf.get(c.id) ?? new Set()).add(s))
      }
    }
  }
  const sources = new Map(model.sources.filter((s) => (s.excerpt ?? '').length >= 40).map((s) => [s.id, s]))
  const { publications, publicationOf } = publicationsOf([...sources.values()])
  return {
    model, sources, claims, sourcesOf, publications, publicationOf,
    bySource: indexOf([...sources.values()].map((s) => ({ id: s.id, text: `${s.title ?? ''} ${s.excerpt ?? ''} ${(about.get(s.id) ?? []).join(' ')}` }))),
    byClaim: indexOf([...claims.values()].map((c) => ({ id: c.id, text: c.statement }))),
  }
}

/** A DOI for a source, where its address carries one: a doi.org link, an arXiv paper, or a publisher's /doi/ path. */
export function doiOfUri(uri: string | undefined): string | null {
  if (!uri) return null
  const doi = uri.match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[^\s?#]+)/i)?.[1]
    ?? uri.match(/\/doi\/(?:abs\/|full\/|pdf\/|epdf\/|book\/)?(10\.\d{4,9}\/[^\s?#]+)/i)?.[1]
  if (doi) return decodeURIComponent(doi).replace(/\/(pdf|full|abstract)$/i, '').replace(/\.pdf$/i, '').toLowerCase()
  const arxiv = uri.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i)?.[1]
  return arxiv ? `10.48550/arxiv.${arxiv}` : null
}

/**
 * A publication as a search result: its excerpts stand where an abstract would, the ones that matched first, and
 * passages are copied from them verbatim. Every excerpt is in it, so a passage another search found is verbatim too.
 */
export function hitOf(p: Publication, first: string[] = []): SearchHit {
  const order = [...p.excerpts].sort((a, b) => (first.includes(a.source) ? first.indexOf(a.source) : Infinity) - (first.includes(b.source) ? first.indexOf(b.source) : Infinity))
  return { id: p.id, doi: p.doi, title: p.title, year: p.year, venue: null, type: p.kind ?? null, authors: [], abstract: order.map((e) => e.text).join(JOIN), oa: null, url: p.uri ?? null }
}

/** The world model's publications closest to a text (a claim, or a search a model wrote), by their passages that match best. */
export function searchWorldModel(m: SearchableModel, text: string, top: number): SearchHit[] {
  const matched = new Map<string, string[]>()
  for (const { id } of rank(m.bySource, text, top * 4)) {
    const p = m.publicationOf.get(id)!
    if (!matched.has(p) && matched.size >= top) continue
    matched.set(p, [...(matched.get(p) ?? []), id])
  }
  return [...matched].map(([p, first]) => hitOf(m.publications.get(p)!, first))
}

/** Who wrote a world model's publication and where it appeared: its DOI's registry record, else OpenAlex's record of it. */
export async function describeWork(m: SearchableModel, work: Work): Promise<void> {
  if (work.authors.length || work.csl) return
  const p = m.publications.get(work.id)
  if (!work.doi && p?.openalex) {
    try {
      const key = openalexKey()
      const response = await fetch(`https://api.openalex.org/works/${p.openalex}?select=doi,publication_year,authorships,primary_location${key ? `&api_key=${encodeURIComponent(key)}` : ''}`, { signal: AbortSignal.timeout(30_000) })
      if (response.ok) {
        const w = await response.json() as { doi?: string; publication_year?: number; authorships?: { author?: { display_name?: string } }[]; primary_location?: { source?: { display_name?: string } } }
        work.doi = w.doi ? w.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() : null
        work.authors = personNames((w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean))
        work.year = w.publication_year ?? work.year
        work.venue = w.primary_location?.source?.display_name ?? work.venue
      }
    } catch { /* the reference keeps what the world model says */ }
  }
  // With neither a DOI nor an OpenAlex id, the work is looked up once by its exact title, so its reference is complete.
  if (!work.doi && !p?.openalex) await completeByTitle(work)
  if (!work.doi) return
  const csl = await cslForDoi(work.doi)
  if (!csl) return
  work.csl = csl
  const names = (csl.author as { given?: string; family?: string; literal?: string }[] | undefined) ?? []
  work.authors = names.map((a) => a.literal ?? [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean)
  const year = (csl.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0]?.[0]
  if (year) work.year = year
  const venue = csl['container-title']
  work.venue = (Array.isArray(venue) ? venue[0] : venue) as string | undefined ?? work.venue
}

/** Several searches at once, answered as the literature index answers them. */
export function searchWorldModelQueries(m: SearchableModel, queries: { id: string; search: string }[], top: number): Record<string, QueryResult> {
  return Object.fromEntries(queries.map((q) => [q.id, { matched: null, status: null, results: searchWorldModel(m, q.search, top) }]))
}

// ---------------------------------------------------------------- a paper's world model

const cache = new Map<string, { mtime: number; m: SearchableModel }>()

/** The paper's world model, read and indexed once per process; null for a paper without one. */
export function worldModelOf(paper: Paper): SearchableModel | null {
  const config = paper.config.worldModel
  if (!config) return null
  const path = paper.path(config.file)
  if (!existsSync(path)) return null
  const mtime = statSync(path).mtimeMs
  const hit = cache.get(path)
  if (hit && hit.mtime === mtime) return hit.m
  const m = searchable(JSON.parse(readFileSync(path, 'utf8')) as WorldModel)
  cache.set(path, { mtime, m })
  return m
}

/** Whether the paper rests only on its world model: no literature search, no systematic review, no web sources. */
export const onlyWorldModel = (paper: Paper) => !!paper.config.worldModel && paper.config.worldModel.only !== false

/** What the seats read about the world model: what it is, and its claims closest to the paper, as ground to build on. */
export function worldModelBlock(paper: Paper, focus: string, limit = 30): string {
  const m = worldModelOf(paper)
  const config = paper.config.worldModel
  if (!m || !config) return ''
  const closest = rank(m.byClaim, focus, limit).map(({ id }) => m.claims.get(id)!)
  const lines = closest.map((c) => `- (${c.uncertainty ?? 'uncertainty not given'}; ${m.sourcesOf.get(c.id)?.size ?? 0} source${m.sourcesOf.get(c.id)?.size === 1 ? '' : 's'}) ${c.statement}`)
  return `THE WORLD MODEL the paper's sources come from: "${config.name}", a Resolvent world model of ${config.claims.toLocaleString('en-US')} claims, each resting on evidence with verbatim passages from its ${config.sources.toLocaleString('en-US')} sources. ${config.only ? 'The paper rests only on this world model: no other literature is searched, so it states as established only what these sources support, and anything else as the paper\'s own argument or as open.' : 'The world model is searched first; the literature and the web are searched for what it does not cover.'} Its claims closest to this paper, with their uncertainty, are ground the argument can build on; every claim the paper makes is still checked against a source's own passage:
${lines.join('\n')}`
}
