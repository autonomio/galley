// Which model families a paper uses: a family that is off hands its seats on,
// no family ever checks its own writing, and a change takes effect mid-run.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adjudicate, handleFinding } from '../../src/engine/behaviors/review.js'
import { adjudicatorFor, applyFamilies, defaultConfig } from '../../src/engine/config.js'
import { Paper } from '../../src/engine/paper.js'
import type { Finding } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const dealt = (families: ('claude' | 'gpt' | 'gemini')[]) => applyFamilies({ ...defaultConfig(), families })

describe('model families', () => {
  it('gives GPT the author\'s seat when Claude is off, and every checking seat to Gemini', () => {
    const c = dealt(['gpt', 'gemini'])
    expect(c.seats).toEqual({ author: 'gpt', checker: 'gemini', challenger: 'gemini', verifier: 'gemini' })
    expect(c.referees.map((r) => r.family)).toEqual(['gemini', 'gemini', 'gemini', 'gemini'])
  })

  it('keeps Claude writing when Gemini is off, and GPT checks', () => {
    const c = dealt(['claude', 'gpt'])
    expect(c.seats).toEqual({ author: 'claude', checker: 'gpt', challenger: 'gpt', verifier: 'gpt' })
  })

  it('needs two families, and settles disputes only with a third', () => {
    expect(() => dealt(['gpt'])).toThrow(/at least two/)
    expect(adjudicatorFor({ families: ['gpt', 'gemini'] }, 'gpt', 'gemini')).toBeNull()
    expect(adjudicatorFor({}, 'claude', 'gpt')).toBe('gemini')
  })

  it('deals the seats again at the next step when the project\'s settings change, and states an unsettled finding as a limitation with two families', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const config = JSON.parse(readFileSync(paper.path('paper.json'), 'utf8'))
    writeFileSync(paper.path('paper.json'), JSON.stringify({ ...config, families: ['gpt', 'gemini'] }))
    expect(paper.refreshFamilies()).toBe(true)
    expect(paper.config.seats.author).toBe('gpt')
    expect(paper.refreshFamilies()).toBe(false)

    const s = paper.state
    s.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: [] }, { id: 'S2', title: 'Limitations', purpose: '', claimIds: [], words: 200, figureIds: [] }], style: '', glossary: [] }
    s.passages = { S1: { sectionId: 'S1', text: 'It always works.', revisions: [], checked: 'faithful' }, S2: { sectionId: 'S2', text: 'One bench.', revisions: [], checked: 'faithful' } }
    const rejected = { at: '', kind: 'fixed' as const, text: 'Fixed.', edits: [], family: 'gpt' as const, verification: { outcome: 'disagrees' as const, reason: 'No.', family: 'gemini' as const } }
    const f: Finding = { id: 'F1', round: 1, seat: 'methods', family: 'gemini', model: 'gemini-4-carbon-high', severity: 'material', sectionId: 'S1', quote: 'always works', question: 'Always?', alternatives: '', evidence: '', decision: 'narrow', edit: null, status: 'open', assignee: 'agents', origin: 'agent', dispositions: [rejected, rejected, rejected] }
    s.findings = [f]
    expect(adjudicate.ready(paper)).toEqual([])
    expect(handleFinding.ready(paper).map((t) => t.label)).toEqual(['F1'])
  })
})
