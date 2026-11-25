// The paper states its work plainly; the agents' caution goes beside the text, as comments in the editor.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { selfTalk } from '../../src/engine/behaviors/proof.js'
import { draft } from '../../src/engine/behaviors/write.js'
import { Paper } from '../../src/engine/paper.js'
import { syncEditor } from '../../src/engine/render.js'
import type { Claim, Finding } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function paper(): Paper {
  dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
  const p = Paper.create(join(dir, 'p'), 'seed', { authors: [{ name: 'Ada' }], editorDir: join(dir, 'docs'), off: ['find-evidence'] })
  p.state.plan = { thesis: 'T', workingTitle: 'Working title', noun: 'n', opens: [], objectType: 'finding' }
  p.state.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: ['C1'], words: 200, figureIds: [] }], style: '', glossary: [] }
  p.state.claims = [{ id: 'C1', text: 'Cold starts dominate latency.', kind: 'background', seedQuote: '', origin: 'seed', need: 'external', loadBearing: true, dependsOn: [], status: 'unsupported', history: [] } as Claim]
  return p
}

describe('caution beside the text', () => {
  it('keeps what a draft would hedge as comments for the authors, and writes them beside the passage in the editor', async () => {
    const p = paper()
    p.ask = (async () => ({
      markdown: 'Cold starts dominate latency. The fleet was measured over one week.',
      used_claims: ['C1'],
      notes: [{ quote: 'The fleet was measured over one week.', note: 'One week may miss seasonal load.' }],
    })) as Paper['ask']
    await draft.ready(p)[0].run()
    expect(p.state.passages.S1.text).toBe('Cold starts dominate latency. The fleet was measured over one week.')
    expect(p.state.authorNotes!.map((n) => [n.kind, n.quote])).toEqual([['caution', 'The fleet was measured over one week.'], ['unverified', '']])

    // A referee point settled as a limitation stays open beside the text, for the authors.
    p.state.findings.push({ id: 'F1', at: '2026-11-20T10:00:00.000Z', round: 1, seat: 'methods', family: 'gpt', model: 'gpt-6.2-sol', severity: 'material', sectionId: 'S1', quote: 'Cold starts dominate latency.', question: 'Only one fleet?', alternatives: '', evidence: '', decision: '', edit: null, status: 'limitation', assignee: 'agents', origin: 'agent', dispositions: [{ at: '2026-11-20T10:01:00.000Z', kind: 'limitation', text: 'One fleet only.', edits: [], family: 'claude', verification: { outcome: 'verified', reason: 'Fair.', family: 'gpt' } }] } as Finding)
    syncEditor(p)
    const notes = JSON.parse(readFileSync(join(dir, 'docs', 'p.annotations.json'), 'utf8')).annotations
    expect(notes.map((a: { id: string, resolved?: boolean, labels?: { text: string }[] }) => [a.id, !!a.resolved, a.labels!.at(-1)!.text])).toEqual([
      ['galley-F1', false, 'limitation · for you'],
      ['galley-note-N1', false, 'caution'],
      ['galley-note-N2', false, 'no verified source'],
    ])
    expect(readFileSync(join(dir, 'docs', 'p.md'), 'utf8')).not.toMatch(/may miss|no verified source/)
  })

  it('finds the sentences in which a paper doubts itself or talks about its own making', () => {
    const text = 'Cold starts dominate latency. No person independently audited citation support or manuscript quality. Submission-ready means only that the gates held. A research model (GPT-6.1 Sol) chose the records. The fleet was measured over one week.'
    expect(selfTalk(text)).toEqual(['No person independently audited citation support or manuscript quality.', 'Submission-ready means only that the gates held.', 'A research model (GPT-6.1 Sol) chose the records.'])
    // A paper about galley itself may name its models; it still never doubts itself.
    expect(selfTalk(text, true)).toEqual(['No person independently audited citation support or manuscript quality.', 'Submission-ready means only that the gates held.'])
  })
})
