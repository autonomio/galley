// The systematic review: Canary's finished bundle becomes ledger claims with
// verified citations and a section of the paper, and the review runs in the
// background without holding up the rest.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { plan } from '../../src/engine/behaviors/front.js'
import { declaration, importReview, REVIEW_SECTION, withReviewSection } from '../../src/engine/literature.js'
import { Paper } from '../../src/engine/paper.js'
import { productionRecord } from '../../src/engine/record.js'
import { runPaper, type Behavior } from '../../src/engine/scheduler.js'
import type { Section } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const ref = (id: string, doi: string) => ({ id, kind: 'fulltext', role: 'core', paper: { ref: id, title: `Study ${id}`, doi: `https://doi.org/${doi}`, authors: ['A. Author', 'B. Author'], year: 2021, url: `https://openalex.org/${id}`, abstract: 'An abstract.' } })
const bundle = {
  key: 'galley-test-run',
  bundle: { created_at: '2026-11-19T10:00:00+00:00' },
  research: {
    run: { started_at: '2026-11-19T10:00:00+00:00', seconds: 2160, research_model: 'gpt-6.1-sol', audit_model: 'gpt-6-astra' },
    query_net: {
      concepts: [{ name: 'street trees', synonyms: ['urban trees'] }],
      eligibility: { core: 'Field studies of street-tree survival.', supporting: 'Reviews of urban soil.', exclusion: 'Greenhouse only.' },
      queries: [{ search: 'street tree survival soil volume' }, { search: 'urban tree pit size' }],
    },
    coverage: { discovered_candidates: 4200, assessed_candidates: 90, retrieved_sources: 55, reviewed_papers: 50, core_papers: 31, supporting_papers: 19 },
    answer: {
      claims: [
        { id: 'C01', text: 'Larger soil volumes  are associated with higher street-tree survival.', uncertainty: { class: 'low' }, evidence_ids: ['E1', 'E2', 'E3'] },
        { id: 'C02', text: 'Pit size effects depend on species.', uncertainty: { class: 'high' }, evidence_ids: ['E4'] },
        { id: 'C03', text: 'Mulch doubles survival.', uncertainty: { class: 'moderate' }, evidence_ids: ['E5'] },
      ],
      evidence: [
        { id: 'E1', paragraph_id: 'W1-p0001', quote: 'Trees with more than 15 m3 of soil survived at higher rates over ten years.', relation: 'supports', interpretation: 'Ten-year cohort.' },
        { id: 'E2', paragraph_id: 'W1-p0002', quote: 'Survival rose with soil volume.', relation: 'supports', interpretation: 'Same cohort.' },
        { id: 'E3', paragraph_id: 'W2-p0001', quote: 'Soil volume predicted survival in all three cities studied here.', relation: 'supports', interpretation: 'Three cities.' },
        { id: 'E4', paragraph_id: 'W3-p0001', quote: 'The effect of pit size differed markedly between the species we planted.', relation: 'qualifies', interpretation: 'Species differ.' },
        { id: 'E5', paragraph_id: 'W2-p0002', quote: 'Mulched trees survived somewhat better in the first year only.', relation: 'supports', interpretation: 'First year.' },
      ],
      passages: [
        { id: 'W1-p0001', reference_id: 'W1' }, { id: 'W1-p0002', reference_id: 'W1' }, { id: 'W2-p0001', reference_id: 'W2' },
        { id: 'W3-p0001', reference_id: 'W3' }, { id: 'W2-p0002', reference_id: 'W2' },
      ],
      references: [ref('W1', '10.1/one'), ref('W2', '10.1/two'), ref('W3', '10.1/three')],
      source_checks: [{ claim_id: 'C01', assessment: 'supported' }, { claim_id: 'C02', assessment: 'partially_supported' }, { claim_id: 'C03', assessment: 'unsupported' }],
      gaps: [{ description: 'No study followed trees beyond ten years.' }],
      contradictions: [{ description: 'Two cohorts disagree on narrow pits.' }],
    },
  },
}

describe('systematic review', () => {
  it('turns the findings the audit upheld into claims with one verified citation per source, and keeps the protocol and counts', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed', { literatureReview: true })
    const s = paper.state
    s.outline = { sections: withReviewSection([{ id: 'S1', title: 'Introduction', purpose: '', claimIds: [], words: 800, figureIds: [] }, { id: 'S2', title: 'Method', purpose: '', claimIds: [], words: 1200, figureIds: [] }], 7000), style: '', glossary: [] }
    s.literature = { question: 'How does soil volume affect street-tree survival?', status: 'running', key: 'galley-test-run' }
    importReview(paper, bundle, 'canary/review-bundle.json')

    const review = s.claims.filter((c) => c.origin === 'review')
    expect(review.map((c) => [c.text, c.status, c.uncertainty])).toEqual([
      ['Larger soil volumes are associated with higher street-tree survival.', 'supported', 'low'],
      ['Pit size effects depend on species.', 'narrowed', 'high'],
    ])
    const first = s.citations.filter((c) => c.claimId === review[0].id)
    expect(first.map((c) => [c.workId, c.status, c.passage])).toEqual([
      ['W1', 'verified', 'Trees with more than 15 m3 of soil survived at higher rates over ten years. … Survival rose with soil volume.'],
      ['W2', 'verified', 'Soil volume predicted survival in all three cities studied here.'],
    ])
    expect(s.works.W1.doi).toBe('10.1/one')
    expect(s.literature.status).toBe('done')
    expect(s.literature.counts).toMatchObject({ discovered: 4200, screened: 90, reviewed: 50, core: 31, supporting: 19, cited: 3, queries: 2, findings: 2, audited: 2, minutes: 36 })
    expect(s.literature.protocol?.concepts).toEqual(['street trees (urban trees)'])
    expect(s.outline.sections.find((sec) => sec.id === REVIEW_SECTION)?.claimIds).toEqual(review.map((c) => c.id))
    expect(productionRecord(paper)['lit.reviewed']).toBe(50)
  })

  it('plans a paper whose contribution is its review only once the review is in; a supporting review never holds the plan', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const brief = { hasSubject: true, concern: 'c', contribution: 'k', objectType: 'finding' as const, field: 'f', audience: 'a' }
    const central = Paper.create(join(dir, 'central'), 'seed', { literatureReview: 'load-bearing', off: ['position', 'review-idea'] })
    central.state.brief = brief
    central.state.literature = { question: 'q', status: 'running', key: 'k' }
    expect(plan.ready(central)).toEqual([])
    central.state.literature.status = 'done'
    expect(plan.ready(central).map((t) => t.key)).toEqual(['plan:argument'])
    const supporting = Paper.create(join(dir, 'supporting'), 'seed', { literatureReview: true, off: ['position', 'review-idea'] })
    supporting.state.brief = brief
    supporting.state.literature = { question: 'q', status: 'running', key: 'k' }
    expect(plan.ready(supporting).map((t) => t.key)).toEqual(['plan:argument'])
  })

  it('places the review section after the introduction, with its words taken from the others, once', () => {
    const sections: Section[] = [1, 2, 3].map((i) => ({ id: `S${i}`, title: `T${i}`, purpose: '', claimIds: [], words: 2000, figureIds: [] }))
    const placed = withReviewSection(sections, 7000)
    expect(placed.map((sec) => sec.id)).toEqual(['S1', REVIEW_SECTION, 'S2', 'S3'])
    expect(placed.reduce((n, sec) => n + sec.words, 0)).toBeCloseTo(6000, -2)
    expect(withReviewSection(placed, 7000)).toBe(placed)
  })

  it('declares the question to Canary as data, with the fixed review settings', () => {
    const yaml = declaration('Does "soil" matter?')
    expect(yaml).toContain('question: "Does \\"soil\\" matter?"')
    expect(yaml).toContain('target_papers: 50')
    expect(yaml).toContain('subagents: false')
  })

  it('runs a background target alongside the rest, and waits for it before the run ends', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const order: string[] = []
    let release = () => {}
    const slow: Behavior = {
      id: 'slow', stage: 'substance', improver: true, title: 'slow',
      ready: () => [{ key: 'slow:1', label: 'slow', background: true, run: () => new Promise<void>((resolve) => { release = () => { order.push('slow'); resolve() } }) }],
    }
    const quick: Behavior = {
      id: 'quick', stage: 'skeleton', improver: false, title: 'quick',
      ready: () => [{ key: 'quick:1', label: 'quick', run: async () => { order.push('quick'); setTimeout(() => release(), 20) } }],
    }
    await runPaper(paper, [slow, quick], { log: () => {} })
    expect(order).toEqual(['quick', 'slow'])
    expect(paper.isSettled('slow:1')).toBe(true)
  })
})

describe('typeset', () => {
  it('writes the editor copy where a stale link to a deleted file stands in its place', async () => {
    const { symlinkSync, readFileSync, lstatSync } = await import('node:fs')
    const { writeReplacing } = await import('../../src/engine/render.js')
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const path = join(dir, 'galley.md')
    symlinkSync(join(dir, 'gone', 'galley.md'), path)
    writeReplacing(path, '# The paper\n')
    expect(lstatSync(path).isSymbolicLink()).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('# The paper\n')
  })
})
