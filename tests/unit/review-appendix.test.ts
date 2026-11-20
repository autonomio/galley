// A systematic review is reported so it can be checked and repeated: every
// included publication, cited or not, every query, how the records were
// narrowed, why the search stopped and what the review cannot claim.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importReview, reviewAppendix, reviewFlowTypst } from '../../src/engine/literature.js'
import { Paper } from '../../src/engine/paper.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const paper = (id: string, title: string) => ({ ref: id, title, doi: `https://doi.org/10.1/${id}`, authors: ['A. Author'], year: 2024, url: `https://openalex.org/${id}` })

const bundle = {
  bundle: { created_at: '2026-11-19T00:00:00Z' },
  research: {
    query_net: { concepts: [{ name: 'telecom batteries' }], eligibility: { core: 'Measured timings.', supporting: 'Methods.', exclusion: 'Unrelated.' }, queries: [{ search: 'telecom battery frequency reserve' }, { search: 'base station battery delay' }] },
    answer: {
      claims: [{ id: 'c1', text: 'Measured activation times are rarely reported for telecom backup batteries.', evidence_ids: ['e1'], uncertainty_class: 'moderate' }],
      evidence: [{ id: 'e1', paragraph_id: 'W1-p1', quote: 'Few studies report measured activation times for these batteries in operation.', relation: 'supports' }],
      passages: [{ id: 'W1-p1', reference_id: 'W1' }],
      references: [
        { id: 'W1', role: 'core', paper: paper('W1', 'Measured latency of telecom batteries'), review: { reason: 'Reports measured activation times.' } },
        { id: 'W2', role: 'supporting', paper: paper('W2', 'Aggregator control for distributed storage'), review: { reason: 'Describes the dispatch path.' } },
      ],
      source_checks: [{ claim_id: 'c1', assessment: 'supported' }],
      coverage: { discovered_candidates: 900, assessed_candidates: 40, retrieved_sources: 12, reviewed_papers: 2, core_papers: 1, supporting_papers: 1, stopping_reason: 'A coverage stopping decision, not exhaustion or a claim of complete recall.' },
    },
    run: { started_at: '2026-11-19T00:00:00Z', research_model: 'gpt-6.1-sol', audit_model: 'gpt-6-astra' },
  },
}

describe('the systematic review appendix', () => {
  it('keeps every included publication, cited or not, and reports protocol, narrowing, queries and limits', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const p = Paper.create(join(dir, 'p'), 'seed')
    p.state.literature = { question: 'What activation times have been measured?', status: 'running', key: 'k1' }
    importReview(p, bundle, 'canary/review-bundle.json')
    const lit = p.state.literature!

    expect(lit.included).toEqual([{ workId: 'W1', role: 'core', reason: 'Reports measured activation times.' }, { workId: 'W2', role: 'supporting', reason: 'Describes the dispatch path.' }])
    expect(p.state.works.W2.title).toBe('Aggregator control for distributed storage')
    expect(lit.counts).toMatchObject({ discovered: 900, screened: 40, retrieved: 12, reviewed: 2, excludedScreening: 28, excludedFullText: 10 })
    expect(lit.limits!.join(' ')).toContain('open-access full text')

    const appendix = reviewAppendix(p, (id) => `[@${id}]`, 'figures/review-flow.png')
    for (const text of ['[@W1] | core', '[@W2] | supporting', '1. telecom battery frequency reserve', '2. base station battery delay', 'not exhaustion', '| Excluded after reading the full text | 10 |', 'figures/review-flow.png']) expect(appendix).toContain(text)
    expect(reviewFlowTypst(lit)).toContain('Not chosen for screening \\ *n = 860*')
  })
})
