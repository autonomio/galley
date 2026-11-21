// A dataset given by its link. The usual way to hand over data is the link to
// where it is published: a Zenodo record, or its DOI. galley reads the record
// for everything the paper needs to describe and cite the data (its title,
// creators, version, DOI, licence, and the publication it supplements),
// downloads its files and unpacks an archive among them, so the dataset arrives
// with its own reference.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { DatasetManifest } from './materials.js'

const UA = process.env.GALLEY_USER_AGENT || 'scholarly-client/0.1'
/** What one record may bring in: enough for a measurement campaign, bounded for a paper folder. */
const MAX_BYTES = 500 * 1024 * 1024
/** Files a dataset keeps from a record: its data and its documentation. */
const KEEP = new Set(['.csv', '.tsv', '.json', '.xlsx', '.md', '.markdown', '.txt', '.pdf', '.rst'])

/** A Zenodo record's number, from its page, its API address or its DOI. Null for any other link. */
export function zenodoRecord(link: string): string | null {
  const text = link.trim()
  return text.match(/zenodo\.org\/(?:api\/)?(?:records?|deposit|uploads)\/(\d+)/i)?.[1]
    ?? text.match(/10\.5281\/zenodo\.(\d+)/i)?.[1]
    ?? null
}

/** Whether a link names a published dataset galley can read: a Zenodo record or its DOI. */
export const isDatasetRecord = (link: string) => zenodoRecord(link) !== null

export interface RecordSummary {
  link: string
  name: string
  creators: string[]
  version?: string
  doi?: string
  url: string
  licence?: string
  year?: number
  describedIn?: string
  citation: string
  files: { name: string; size: number; url: string }[]
}

/** What a record says about itself, without downloading anything: for the start dialog to show, and for the manifest. */
export async function readRecord(link: string): Promise<RecordSummary> {
  const id = zenodoRecord(link)
  if (!id) throw new Error(`${link} is not a dataset record galley can read (a Zenodo record or its DOI)`)
  const response = await fetch(`https://zenodo.org/api/records/${id}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Zenodo record ${id}: HTTP ${response.status}`)
  const r = await response.json() as any
  const m = r.metadata ?? {}
  const creators: string[] = (m.creators ?? []).map((c: any) => String(c.name ?? '')).filter(Boolean)
  const year = Number(String(m.publication_date ?? '').slice(0, 4)) || undefined
  const doi = String(r.doi ?? m.doi ?? '').toLowerCase() || undefined
  // The publication a dataset supplements or is described by is the one that first reported it, when it is a paper.
  const paper = (m.related_identifiers ?? []).find((x: any) => /^(isSupplementTo|isDescribedBy|isDocumentedBy)$/i.test(x.relation ?? '') && /publication|article|preprint|paper/i.test(x.resource_type ?? 'publication') && !/github\.com/i.test(x.identifier ?? ''))
  const name = String(m.title ?? `Zenodo record ${id}`).trim()
  const version = m.version ? String(m.version) : undefined
  return {
    link, name, creators, version, doi, year, url: `https://zenodo.org/records/${id}`, licence: m.license?.id ? String(m.license.id).toUpperCase() : undefined,
    ...(paper ? { describedIn: String(paper.identifier) } : {}),
    citation: `${creators.join(', ') || 'Unknown'} (${year ?? 'n.d.'}). ${name}${version ? ` (${version})` : ''}. Zenodo.${doi ? ` https://doi.org/${doi}` : ''}`,
    files: (r.files ?? []).map((f: any) => ({ name: String(f.key ?? ''), size: Number(f.size) || 0, url: String(f.links?.self ?? f.links?.download ?? '') })).filter((f: { name: string; url: string }) => f.name && f.url),
  }
}

/** Every file under a folder, depth first, leaving out what an archive carries for its own sake. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.') || name === '__MACOSX') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

/**
 * A dataset as its record gives it: the record's files downloaded into a folder (an archive unpacked), its data and
 * documentation kept, and its provenance filled in from the record. The data is described as published by its
 * creators unless the person says they are among them.
 */
export async function datasetFromRecord(link: string, dir: string, overrides: Partial<DatasetManifest> = {}): Promise<DatasetManifest> {
  const record = await readRecord(link)
  if (!record.files.length) throw new Error(`${record.url} lists no files to download`)
  const total = record.files.reduce((n, f) => n + f.size, 0)
  if (total > MAX_BYTES) throw new Error(`${record.url} holds ${Math.round(total / 1e6)} MB, more than the ${MAX_BYTES / 1e6} MB a paper takes in`)
  const folder = join(dir, `record-${zenodoRecord(link)}`)
  mkdirSync(folder, { recursive: true })
  for (const file of record.files) {
    const response = await fetch(file.url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(600_000) })
    if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`)
    const path = join(folder, basename(file.name))
    writeFileSync(path, Buffer.from(await response.arrayBuffer()))
    if (extname(path).toLowerCase() === '.zip') {
      const unpacked = join(folder, basename(path, '.zip'))
      mkdirSync(unpacked, { recursive: true })
      execFileSync('unzip', ['-q', '-o', path, '-d', unpacked])
    }
  }
  const files = filesUnder(folder).filter((path) => KEEP.has(extname(path).toLowerCase()))
  if (!files.some((path) => /\.(csv|tsv|json|xlsx)$/i.test(path))) throw new Error(`${record.url} holds no data file galley can read (CSV, TSV, JSON or Excel)`)
  return {
    name: record.name, files, producedBy: 'others', version: record.version, doi: record.doi, url: record.url,
    describedIn: record.describedIn, licence: record.licence, citation: record.citation, private: false, ...overrides,
  }
}
