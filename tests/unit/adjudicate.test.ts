// Disputed findings are settled in one call per section and family, against that
// section alone, and each decision lands on its own finding.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adjudicate } from '../../src/engine/behaviors/review.js'
import { Paper } from '../../src/engine/paper.js'
import type { Finding } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const disputed = (id: string, sectionId: string, quote: string): Finding => ({
  id, round: 1, seat: 'methods', family: 'gpt', model: 'gpt-6.2-sol', severity: 'material', sectionId, quote, question: `Is "${quote}" supported?`,
  alternatives: '', evidence: '', decision: 'narrow it', edit: null, status: 'open', assignee: 'agents', origin: 'agent',
  dispositions: [1, 2, 3].map(() => ({ at: '', kind: 'rebutted' as const, text: 'It stands.', edits: [], family: 'claude' as const, verification: { outcome: 'disagrees' as const, reason: 'Still too strong.', family: 'gpt' as const } })),
})

describe('adjudication', () => {
  it('settles the disputed findings of one section in one call that reads that section only', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const s = paper.state
    s.outline = { sections: [{ id: 'S1', title: 'Method', purpose: '', claimIds: [], words: 300, figureIds: [] }, { id: 'S2', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: [] }], style: '', glossary: [] }
    s.passages = {
      S1: { sectionId: 'S1', text: 'The bench always switches in 200 ms. The meter resolves 10 ms.', revisions: [], checked: 'faithful' },
      S2: { sectionId: 'S2', text: 'Every product is served.', revisions: [], checked: 'faithful' },
    }
    s.findings = [disputed('F1', 'S1', 'always switches in 200 ms'), disputed('F2', 'S1', 'resolves 10 ms'), disputed('F3', 'S2', 'Every product is served')]
    const targets = adjudicate.ready(paper)
    expect(targets.map((t) => t.label)).toEqual(['2 finding(s) in S1 by gemini', '1 finding(s) in S2 by gemini'])

    const prompts: string[] = []
    paper.ask = (async (options: { prompt: string }) => {
      prompts.push(options.prompt)
      return { decisions: [
        { id: 'F1', decision: 'narrow', reason: 'Only the median is 200 ms.', edits: [{ old: 'always switches in 200 ms', new: 'switches in a median of 200 ms' }] },
        { id: 'F2', decision: 'adopt_author', reason: 'The meter spec says so.', edits: [] },
      ] }
    }) as Paper['ask']
    await targets[0].run()

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('The bench always switches in 200 ms.')
    expect(prompts[0]).not.toContain('Every product is served.')
    expect(s.passages.S1.text).toBe('The bench switches in a median of 200 ms. The meter resolves 10 ms.')
    expect(s.findings.map((f) => f.status)).toEqual(['adjudicated', 'adjudicated', 'open'])
    expect(s.findings[1].adjudication?.decision).toMatch(/^adopt_author/)
  })
})
