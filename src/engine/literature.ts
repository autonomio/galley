// A systematic review of the literature, done by Canary. Galley writes the
// review question; Canary plans the search, screens the candidates, reads the
// full papers, ties every finding to verbatim passages and audits each in a
// separate session. Galley turns the finished research bundle into ledger
// claims with verified citations and a section of the paper.
import { spawn } from 'node:child_process'
import { canaryPython, openalexKey } from './evidence.js'
import type { Paper } from './paper.js'
import type { Citation, Claim, LiteratureReview, Section, Work } from './types.js'

export const REVIEW_SECTION = 'LR'
// The current Canary compiler requires the same model and effort for both roles.
const REVIEW_MODEL = { model: 'gpt-6.1-sol', effort: 'xhigh' }
const TARGET_PAPERS = 50
/** What the start dialog says about the review: who does it and how much it reads. */
export const REVIEW_SETTINGS = { research: REVIEW_MODEL.model, audit: REVIEW_MODEL.model, papers: TARGET_PAPERS }
const port = () => Number(process.env.CANARY_RUNS_PORT || 8789)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The declaration Canary compiles: the question and the review's fixed settings. */
export function declaration(question: string, targetPapers = TARGET_PAPERS): string {
  return [
    'version: 1',
    `question: ${JSON.stringify(question)}`,
    `research: {model: ${REVIEW_MODEL.model}, effort: ${REVIEW_MODEL.effort}}`,
    `audit: {model: ${REVIEW_MODEL.model}, effort: ${REVIEW_MODEL.effort}}`,
    `retrieval: {selection: coverage, target_papers: ${targetPapers}, corpus: fresh, access: open_full_text}`,
    'subagents: false',
  ].join('\n') + '\n'
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port()}${path}`, { ...init, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000) })
  const text = await response.text()
  let data: any = null
  try { data = JSON.parse(text) } catch { /* not JSON */ }
  if (!response.ok) throw new Error(`Canary ${path}: ${data?.error ?? `HTTP ${response.status}`}${data?.issues ? ` ${JSON.stringify(data.issues).slice(0, 400)}` : ''}`)
  return data
}

async function answering(): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port()}/api/runs/galley-ping`, { signal: AbortSignal.timeout(10_000) }); return true } catch { return false }
}

/** Canary's local service: started if it is not running, with the OpenAlex key when there is one. */
export async function ensureCanary(): Promise<void> {
  if (await answering()) return
  const key = openalexKey()
  spawn(canaryPython(), ['-m', 'canary.cli', 'runs', 'serve', '--port', String(port())], { detached: true, stdio: 'ignore', env: key ? { ...process.env, OPENALEX_API_KEY: key } : process.env }).unref()
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    if (await answering()) return
  }
  throw new Error(`Canary's service did not start on port ${port()}`)
}

export async function submitReview(question: string, name: string, targetPapers = TARGET_PAPERS): Promise<string> {
  await ensureCanary()
  const started = await call('/api/runs', { method: 'POST', body: JSON.stringify({ yaml: declaration(question, targetPapers), name, brief: question }) })
  if (!started?.key) throw new Error('Canary did not return a run key')
  return String(started.key)
}

const TERMINAL = /answered|fail|stopped|cancel|interrupt|no_accessible|insufficient|exhaust|unverified|blocked|invalid|converged|done/i

export async function reviewRun(key: string): Promise<{ status: string; ended: boolean; covered: number | null }> {
  const run = await call(`/api/runs/${encodeURIComponent(key)}`)
  const status = String(run.status ?? '')
  return { status, ended: !!run.ended_at || (run.live === false && TERMINAL.test(status)), covered: run.papers_covered ?? null }
}

export async function reviewBundle(key: string): Promise<any> {
  return call(`/api/runs/${encodeURIComponent(key)}/bundle`)
}

/** Wait for a Canary run to end, riding out a service that stops answering for a while. */
export async function awaitReview(key: string, onPoll: (covered: number | null) => void = () => {}): Promise<string> {
  let errors = 0
  for (;;) {
    try {
      const run = await reviewRun(key)
      errors = 0
      onPoll(run.covered)
      if (run.ended) return run.status
    } catch (error) {
      if (++errors > 30) throw error
      await ensureCanary().catch(() => {})
    }
    await sleep(60_000)
  }
}

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim()

/** gpt-6.1-sol as a reader expects it: GPT-6.1 Sol. */
export const modelName = (id = '') => id.split('-').map((part, i) => i === 0 ? part.toUpperCase() : /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(' ').replace(/^(\w+) (\d[\d.]*)/, '$1-$2')

/** A passage short enough to read in a prompt and a ledger: the quote's opening, cut at a word. */
export function excerpt(quote: string, max = 500): string {
  const text = tidy(quote)
  if (text.length <= max) return text
  return `${text.slice(0, text.lastIndexOf(' ', max))} …`
}

/** A source's quoted passages for one finding, supporting ones first, each cut at a word, joined within a bound. */
export function passageOf(quotes: { text: string; relation: string }[], max = 1600): string {
  const ordered = [...quotes].sort((a, b) => Number(b.relation === 'supports') - Number(a.relation === 'supports'))
  const parts: string[] = []
  let used = 0
  for (const q of ordered) {
    const part = excerpt(q.text, Math.min(600, max - used))
    if (!part || used + part.length > max) break
    parts.push(part)
    used += part.length + 3
  }
  return parts.join(' … ')
}

/** The review's place in the outline: after the introduction, its words taken evenly from the other sections. */
export function withReviewSection(sections: Section[], totalWords: number): Section[] {
  if (sections.some((s) => s.id === REVIEW_SECTION)) return sections
  const share = Math.min(1800, Math.max(700, Math.round(totalWords * 0.15)))
  const rest = sections.reduce((n, s) => n + s.words, 0)
  const scale = rest > 0 ? Math.max(0.5, (rest - share) / rest) : 1
  const scaled = sections.map((s) => ({ ...s, words: Math.max(150, Math.round(s.words * scale)) }))
  const review: Section = {
    id: REVIEW_SECTION, title: 'Systematic Literature Review', words: share, claimIds: [], figureIds: [],
    purpose: 'Reports the systematic review of prior work carried out for this paper: how the literature was searched, screened and read, what it establishes, where studies disagree or are silent, and where this paper stands relative to it.',
  }
  return [...scaled.slice(0, 1), review, ...scaled.slice(1)]
}

const nextId = (ids: string[], prefix: string) => `${prefix}${Math.max(0, ...ids.filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(prefix.length)) || 0)) + 1}`
const doiOf = (doi: unknown) => typeof doi === 'string' && doi ? doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() : null

/**
 * The finished bundle into the paper: each finding the audit upheld becomes a
 * background claim, each of its sources a verified citation with the passage
 * Canary quoted, and the protocol and counts are kept for the section.
 */
export function importReview(paper: Paper, data: any, bundlePath: string): void {
  const s = paper.state
  const lit = s.literature as LiteratureReview
  const research = data?.research ?? {}
  const answer = research.answer ?? {}
  const net = research.query_net ?? {}
  const coverage = research.coverage ?? answer.coverage ?? {}
  const run = research.run ?? {}
  const passages = new Map<string, any>((answer.passages ?? []).map((p: any) => [p.id, p]))
  const references = new Map<string, any>((answer.references ?? []).map((r: any) => [r.id, r]))
  const evidence = new Map<string, any>((answer.evidence ?? []).map((e: any) => [e.id, e]))
  const checks = new Map<string, any>((answer.source_checks ?? []).map((c: any) => [c.claim_id, c]))
  const claimIds: string[] = []
  const cited = new Set<string>()
  let audited = 0
  for (const finding of answer.claims ?? []) {
    const assessment = String(checks.get(finding.id)?.assessment ?? '')
    // A finding the independent audit did not uphold stays out of the paper.
    if (assessment && !/^supported$|partial|qualif/i.test(assessment)) continue
    // Every passage Canary quoted from a source for this finding, so the citation carries what the finding states.
    const bySource = new Map<string, { quotes: { text: string; relation: string }[]; interpretation: string; ref: any }>()
    for (const id of finding.evidence_ids ?? []) {
      const e = evidence.get(id)
      if (!e) continue
      const refId = passages.get(e.paragraph_id)?.reference_id ?? String(e.paragraph_id ?? '').replace(/-p\d+$/, '')
      const ref = references.get(refId)
      const text = tidy(String(e.quote ?? ''))
      if (!ref?.paper || text.length < 20) continue
      const entry = bySource.get(refId) ?? { quotes: [], interpretation: String(e.interpretation ?? ''), ref }
      if (!entry.quotes.some((q) => q.text === text)) entry.quotes.push({ text, relation: String(e.relation ?? 'supports') })
      bySource.set(refId, entry)
    }
    if (!bySource.size) continue
    if (assessment) audited++
    const uncertainty = String(finding.uncertainty?.class ?? finding.uncertainty_class ?? 'moderate') as Claim['uncertainty']
    const claim: Claim = {
      id: nextId(s.claims.map((c) => c.id), 'C'), text: tidy(String(finding.text)), kind: 'background', seedQuote: '', origin: 'review',
      need: 'external', loadBearing: false, dependsOn: [], status: assessment && !/^supported$/i.test(assessment) ? 'narrowed' : 'supported',
      uncertainty: ['low', 'moderate', 'high'].includes(uncertainty ?? '') ? uncertainty : 'moderate',
      history: [{ at: new Date().toISOString(), behavior: 'literature-review', from: '', to: tidy(String(finding.text)), reason: `finding ${finding.id} of Canary run ${lit.key}; independent audit: ${assessment || 'not reached'}` }],
    }
    s.claims.push(claim)
    claimIds.push(claim.id)
    for (const [refId, best] of bySource) {
      const p = best.ref.paper
      const relation = best.quotes.some((q) => q.relation === 'supports') ? 'supports' : best.quotes[0].relation
      const existing = Object.values(s.works).find((w) => w.id === refId || (doiOf(p.doi) && w.doi === doiOf(p.doi)))
      const work: Work = existing ?? {
        id: refId, doi: doiOf(p.doi), title: tidy(String(p.title ?? '')), authors: (p.authors ?? []).map(String), year: Number(p.year) || null,
        venue: p.venue ?? null, abstract: String(p.abstract ?? ''), citedBy: null, url: p.url ?? null,
      }
      s.works[work.id] = work
      cited.add(work.id)
      const citation: Citation = {
        id: nextId(s.citations.map((c) => c.id), 'K'), claimId: claim.id, workId: work.id, passage: passageOf(best.quotes),
        role: relation === 'contradicts' ? 'contrast' : 'support', status: 'verified', chosenBy: 'auto',
        verdict: { outcome: claim.status === 'narrowed' ? 'narrower' : 'supported', reason: `Canary systematic review: ${tidy(best.interpretation) || 'verbatim passage from the full text'}`, family: 'gpt' },
      }
      s.citations.push(citation)
    }
  }
  const eligibility = net.eligibility ?? {}
  lit.status = 'done'
  lit.finishedAt = new Date().toISOString()
  lit.bundle = bundlePath
  lit.searchedOn = String(run.started_at ?? data?.bundle?.created_at ?? '').slice(0, 10)
  lit.models = { research: String(run.research_model ?? REVIEW_MODEL.model), audit: String(run.audit_model ?? REVIEW_MODEL.model) }
  lit.protocol = {
    concepts: (net.concepts ?? []).map((c: any) => c.synonyms?.length ? `${c.name} (${c.synonyms.slice(0, 4).join(', ')})` : String(c.name)),
    eligibility: { core: tidy(String(eligibility.core ?? '')), supporting: tidy(String(eligibility.supporting ?? '')), exclusion: tidy(String(eligibility.exclusion ?? '')) },
    queries: (net.queries ?? []).map((q: any) => String(q.search)),
  }
  const n = (x: unknown) => Number(x) || 0
  lit.counts = {
    discovered: n(coverage.discovered_candidates ?? run.discovered), screened: n(coverage.assessed_candidates),
    retrieved: n(coverage.retrieved_sources ?? run.available_unique_sources), reviewed: n(coverage.reviewed_papers ?? run.papers_reviewed),
    core: n(coverage.core_papers ?? run.papers_core), supporting: n(coverage.supporting_papers ?? run.papers_supporting),
    cited: cited.size, queries: lit.protocol.queries.length, findings: claimIds.length, audited, minutes: Math.round(n(run.seconds) / 60),
  }
  lit.gaps = (answer.gaps ?? []).map((g: any) => tidy(String(g.description ?? ''))).filter(Boolean).slice(0, 8)
  lit.contradictions = (answer.contradictions ?? []).map((k: any) => tidy(String(k.description ?? ''))).filter(Boolean).slice(0, 6)
  lit.claimIds = claimIds
  const section = s.outline?.sections.find((sec) => sec.id === REVIEW_SECTION)
  if (section) section.claimIds = claimIds
}

/** The review's placeholders, for the one section that reports it. */
export const LIT_PLACEHOLDERS: Record<string, string> = {
  'lit.discovered': 'records the searches identified',
  'lit.screened': 'candidates screened by title and abstract',
  'lit.retrieved': 'full texts retrieved',
  'lit.reviewed': 'publications read in full and included',
  'lit.core': 'included studies that answer the question directly (core)',
  'lit.supporting': 'included studies that inform it (supporting)',
  'lit.queries': 'search queries run',
  'lit.findings': 'findings reported',
  'lit.audited': 'findings the independent audit checked',
  'lit.cited': 'included publications cited',
}

/** What the review section may state about how the review was done, besides its findings. */
export function literatureBlock(paper: Paper): string {
  const lit = paper.state.literature
  if (lit?.status !== 'done' || !lit.protocol) return ''
  return `THE SYSTEMATIC REVIEW, carried out for this paper with Canary (searched ${lit.searchedOn}). Its method, disagreements and open questions below may be stated as facts of the review:
Review question: ${lit.question}
Source: OpenAlex (titles, abstracts and indexed full text); open-access full texts only.
Concepts searched: ${lit.protocol.concepts.join('; ') || 'as in the question'}
Search queries: ${lit.protocol.queries.map((q) => `"${q}"`).join('; ')}
Eligible as core studies: ${lit.protocol.eligibility.core}
Eligible as supporting studies: ${lit.protocol.eligibility.supporting}
Excluded: ${lit.protocol.eligibility.exclusion}
How it was done: a research session (${modelName(lit.models?.research)}) planned the search, screened candidates by title and abstract, retrieved and read the full texts, and extracted each finding with the verbatim passages it rests on. A separate audit session (${modelName(lit.models?.audit)}) checked every finding against those passages.
Where the studies disagree: ${lit.contradictions?.join(' | ') || 'none recorded'}
What they leave open: ${lit.gaps?.join(' | ') || 'none recorded'}
The review's numbers, written only as these placeholders:
${Object.entries(LIT_PLACEHOLDERS).map(([key, meaning]) => `{{${key}}}: ${meaning}`).join('\n')}`
}

/** How the review section is written, on top of the rules every section follows. */
export const REVIEW_SECTION_RULES = `This section reports the systematic review above. Write it in this order:
1. How the review was done, in one paragraph: the question, the source and the queries, the eligibility criteria, the screening and full-text reading, and the independent audit, with every count as its placeholder.
2. What the reviewed studies establish, organised by theme rather than study by study: each finding above with its citations, worded to its uncertainty (low: state it plainly; moderate: what the evidence indicates; high: what limited evidence suggests).
3. Where the studies disagree and what they leave open, from the review above.
4. One short paragraph relating this paper's contribution to what the review found, claiming no more than the paper's own claims.
The review's method, disagreements and open questions above may be stated as facts of the review; every other factual sentence states one of the findings.`
