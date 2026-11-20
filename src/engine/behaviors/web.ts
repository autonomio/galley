// Primary sources from the web. Many claims rest on documents no scholarly index
// holds: the rules of a grid operator, a standard, a regulation, a datasheet,
// official statistics, a government report. When the scholarly search finds no
// source for a claim, a model with live web search looks for the primary
// document from whoever issues it. galley fetches each document itself and keeps
// a copy, the checker copies the exact passage that states the claim, and the
// passage goes to verification by another family like any other citation. No
// passage, no citation; a document that cannot be read is named for a person.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { htmlText } from '../materials.js'
import type { Paper } from '../paper.js'
import { HOUSE } from '../prompts.js'
import type { Behavior, Target } from '../scheduler.js'
import { arr, enm, obj, str } from '../schema.js'
import { isVerbatim, overlap } from '../text.js'
import type { Claim, Work } from '../types.js'
import { activeClaims, live, seatFamily, setClaim } from './common.js'
import { awaitsWebSearch, PER_CLAIM, selectNext } from './truth.js'

const BATCH = 4
const MAX_BYTES = 25 * 1024 * 1024
/** Places that are never the primary document: encyclopedias, social media, blogs and forums. */
const NOT_PRIMARY = /(^|\.)(wikipedia\.org|wikimedia\.org|medium\.com|reddit\.com|quora\.com|blogspot\.com|wordpress\.com|substack\.com|linkedin\.com|youtube\.com|x\.com|twitter\.com|facebook\.com|researchgate\.net)$/i
const UA = process.env.GALLEY_USER_AGENT || 'scholarly-client/0.1'

export interface Fetched { url: string; title: string; text: string; sha256: string; kind: 'pdf' | 'html' | 'text'; file: string; retrieved: string }

/** A document fetched by galley itself and kept: its copy, its text and a fingerprint, so the citation can be checked later. */
export async function fetchDocument(paper: Paper, url: string): Promise<Fetched | { url: string; error: string }> {
  let host = ''
  try { host = new URL(url).hostname } catch { return { url, error: 'not a web address' } }
  if (NOT_PRIMARY.test(host)) return { url, error: `${host} is not a primary source` }
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
    if (!response.ok) return { url, error: `HTTP ${response.status}` }
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > MAX_BYTES) return { url, error: 'larger than 25 MB' }
    const type = response.headers.get('content-type') ?? ''
    const sha256 = createHash('sha256').update(body).digest('hex')
    const dir = paper.path('sources')
    mkdirSync(dir, { recursive: true })
    const kind: Fetched['kind'] = /pdf/i.test(type) || body.subarray(0, 5).toString() === '%PDF-' ? 'pdf' : /html/i.test(type) ? 'html' : 'text'
    const file = join('sources', `${sha256.slice(0, 16)}.${kind === 'pdf' ? 'pdf' : kind === 'html' ? 'html' : 'txt'}`)
    writeFileSync(paper.path(file), body)
    const raw = body.toString('utf8')
    const text = kind === 'pdf'
      ? execFileSync('pdftotext', ['-layout', paper.path(file), '-'], { maxBuffer: 64 * 1024 * 1024 }).toString()
      : kind === 'html' ? htmlText(raw) : raw
    const title = kind === 'html' ? (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim() : ''
    writeFileSync(paper.path('sources', `${sha256.slice(0, 16)}.txt`), text)
    // A page that is mostly a login wall or a cookie notice is not the document.
    if (text.replace(/\s+/g, ' ').trim().length < 600) return { url, error: 'too little readable text (perhaps paywalled or behind a login)' }
    return { url: response.url || url, title, text, sha256, kind, file, retrieved: new Date().toISOString().slice(0, 10) }
  } catch (error) {
    return { url, error: (error as Error).message.slice(0, 200) }
  }
}

/** The parts of a long document that speak to a claim: its paragraphs ranked by the words they share with it, in reading order. */
export function relevantText(text: string, claimText: string, budget = 12_000): string {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/[ \t]+/g, ' ').trim()).filter((p) => p.length > 40)
  if (paragraphs.join('\n\n').length <= budget) return paragraphs.join('\n\n')
  const ranked = paragraphs.map((p, i) => ({ p, i, score: overlap(p, claimText) })).sort((a, b) => b.score - a.score)
  const kept: { p: string; i: number }[] = []
  let used = 0
  for (const r of ranked) {
    if (used + r.p.length > budget) continue
    kept.push(r)
    used += r.p.length + 2
  }
  return kept.sort((a, b) => a.i - b.i).map((r) => r.p).join('\n\n')
}

export const findWebSources: Behavior = {
  id: 'web-sources', stage: 'truth', improver: true, title: 'Find primary sources on the web',
  ready: (paper) => {
    if (!live(paper) || !paper.state.outline) return []
    const waiting = activeClaims(paper).filter((c) => awaitsWebSearch(paper, c))
    const groups: Claim[][] = []
    for (let i = 0; i < waiting.length; i += BATCH) groups.push(waiting.slice(i, i + BATCH))
    return groups.map((group): Target => {
      const ids = group.map((c) => c.id)
      const done = () => { for (const c of group) paper.state.attempts[`web:${c.id}`] = 1 }
      return {
        key: `web-sources:${ids.join(',')}`, label: `primary sources for ${ids.join(', ')}`,
        run: async () => {
          // Only GPT's calls can search the web; the search writes no claim and judges nothing.
          const found = await paper.ask<any>({
            behavior: 'web-sources', target: ids.join(','), seat: 'checker', family: 'gpt', web: true,
            prompt: `${HOUSE}

No scholarly source was found for the claims below. Search the web for the primary documents that state them: the rules, standards, specifications, datasheets, statistics or reports of the organisation that issues them (a regulator, a grid or market operator, a standards body, a manufacturer, a statistics office, a government or an international agency). Prefer the issuer's own site and the current version. Never use news, blogs, encyclopedias, forums, social media or secondary summaries. Search with the claim's own terms; the claims carry no private data. For each claim give at most two documents: url (the document itself, a PDF where the issuer publishes one), title, publisher (the issuing organisation), authority (why this document is the primary source for the claim), and date (its date or version as shown, or an empty string). Give none for a claim no primary document states.

${group.map((c) => `${c.id}: ${c.text}`).join('\n')}`,
            schema: obj({ sources: arr(obj({ claim_id: str(), url: str(), title: str(), publisher: str(), authority: str(), date: str() })) }),
          })
          const wanted = (found.sources ?? []).filter((s: any) => ids.includes(s.claim_id)).slice(0, BATCH * 2)
          const fetched = new Map<string, Fetched>()
          const unreadable: { claim: string; url: string; title: string; why: string }[] = []
          for (const s of wanted) {
            if (fetched.has(s.url)) continue
            const doc = await fetchDocument(paper, String(s.url))
            if ('error' in doc) unreadable.push({ claim: s.claim_id, url: String(s.url), title: String(s.title ?? ''), why: doc.error })
            else fetched.set(String(s.url), doc)
          }
          const offered = wanted.filter((s: any) => fetched.has(s.url))
          if (offered.length) {
            // The checker copies, from galley's own copy of each document, the exact passage that states the claim.
            const reply = await paper.ask<any>({
              behavior: 'web-sources', target: `${ids.join(',')}:passages`, seat: 'checker', family: seatFamily(paper, 'checker'),
              prompt: `${HOUSE}

For each claim, read the documents found for it and copy the exact passage (one to three consecutive sentences, verbatim, character for character from the document text) that states the claim or a narrower version of it. fit: direct (the passage states the claim), narrower (a narrower or weaker version), indirect (related but not the claim itself). Choose nothing when no passage states it; never stretch a passage.

${group.map((c) => {
  const docs = offered.filter((s: any) => s.claim_id === c.id)
  return `CLAIM ${c.id}: ${c.text}\n${docs.length ? docs.map((s: any) => `  DOCUMENT ${createHash('sha256').update(s.url).digest('hex').slice(0, 8)}: ${s.title} (${s.publisher}${s.date ? `, ${s.date}` : ''})\n  TEXT:\n${relevantText(fetched.get(s.url)!.text, c.text)}`).join('\n\n') : '  (no documents)'}`
}).join('\n\n')}`,
              schema: obj({ claims: arr(obj({ claim_id: str(), choices: arr(obj({ document: str(), passage: str(), fit: enm(['direct', 'narrower', 'indirect']) })) })) }),
            })
            for (const item of reply.claims ?? []) {
              const c = group.find((k) => k.id === item.claim_id)
              if (!c) continue
              let added = 0
              for (const choice of item.choices ?? []) {
                const source = offered.find((s: any) => s.claim_id === c.id && createHash('sha256').update(s.url).digest('hex').slice(0, 8) === choice.document)
                const doc = source && fetched.get(source.url)
                if (!doc || !isVerbatim(choice.passage, doc.text)) continue
                const work = webWork(paper, doc, source)
                paper.state.candidates.push({ claimId: c.id, workId: work.id, passage: String(choice.passage).trim(), fit: choice.fit, role: 'support', note: `primary source: ${source.authority}` })
                added++
              }
              // A primary source found: the claim goes back to verification, where another family judges the passage.
              if (added) {
                setClaim(paper, c, 'open', 'web-sources', 'a primary source was found on the web; its passage goes to verification')
                if (!selectNext(paper, c.id, PER_CLAIM).length) setClaim(paper, c, 'unsupported', 'web-sources', 'no usable passage in the primary sources found')
              }
            }
          }
          for (const u of unreadable) paper.note('web-sources', `A primary source for ${u.claim} was found but could not be read (${u.why}): ${u.title ? `${u.title}, ` : ''}${u.url}. Supply it if the claim should cite it.`, true)
          paper.journal({ event: 'web-sources', claims: ids, found: wanted.length, fetched: fetched.size, unreadable: unreadable.length })
          done()
          paper.save()
        },
        skip: done,
      }
    })
  },
}

/** A fetched document as a work: cited by its issuer, title and address, with the date galley retrieved it. */
function webWork(paper: Paper, doc: Fetched, source: { title?: string; publisher?: string; date?: string }): Work {
  const id = `web:${doc.sha256.slice(0, 16)}`
  const year = Number(String(source.date ?? '').match(/\b(19|20)\d{2}\b/)?.[0]) || null
  const [y, m, d] = doc.retrieved.split('-').map(Number)
  const title = String(source.title || doc.title || doc.url)
  const publisher = String(source.publisher ?? '').trim()
  paper.state.works[id] ??= {
    id, doi: null, title, authors: publisher ? [publisher] : [], year, venue: publisher || null, abstract: '', citedBy: null, url: doc.url,
    csl: {
      type: doc.kind === 'pdf' ? 'report' : 'webpage', title, URL: doc.url, accessed: { 'date-parts': [[y, m, d]] },
      ...(publisher ? { publisher, author: [{ literal: publisher }] } : {}), ...(year ? { issued: { 'date-parts': [[year]] } } : {}),
    },
  } as Work
  return paper.state.works[id]
}
