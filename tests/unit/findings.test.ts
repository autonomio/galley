// No referee finding is dropped: a rejected answer is answered again at full
// effort, a verdict that cannot tell is asked again, a decision must land in the
// text, and what adjudication cannot settle the paper states as a limitation.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adjudicate, handleFinding, resolved, respond, verifyDisposition } from '../../src/engine/behaviors/review.js'
import { Paper } from '../../src/engine/paper.js'
import type { Disposition, Finding } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function paperWith(findings: Finding[]): Paper {
  dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
  const paper = Paper.create(join(dir, 'p'), 'seed')
  const s = paper.state
  s.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: [] }, { id: 'S2', title: 'Limitations', purpose: '', claimIds: [], words: 200, figureIds: [] }], style: '', glossary: [] }
  s.passages = {
    S1: { sectionId: 'S1', text: 'The bench always switches in 200 ms. The meter resolves 10 ms.', revisions: [], checked: 'faithful' },
    S2: { sectionId: 'S2', text: 'The bench used one vendor.', revisions: [], checked: 'faithful' },
  }
  s.findings = findings
  return paper
}

const rejected = (): Disposition => ({ at: '', kind: 'fixed', text: 'Fixed.', edits: [], family: 'claude', verification: { outcome: 'disagrees', reason: 'Still too strong.', family: 'gpt' } })
const finding = (id: string, quote: string, dispositions: Disposition[], status: Finding['status'] = 'open'): Finding => ({
  id, round: 1, seat: 'methods', family: 'gpt', model: 'gpt-6.2-sol', severity: 'material', sectionId: 'S1', quote, question: `Is "${quote}" supported?`,
  alternatives: '', evidence: '', decision: 'narrow it', edit: null, status, assignee: 'agents', origin: 'agent', dispositions,
})

describe('referee findings', () => {
  it('answers a rejected finding again at full effort, and gives a finding the reply left out its next attempt', async () => {
    const paper = paperWith([finding('F1', 'always switches in 200 ms', [rejected()]), finding('F2', 'resolves 10 ms', [rejected()])])
    const asked: { light?: boolean }[] = []
    paper.ask = (async (options: { light?: boolean }) => {
      asked.push(options)
      return { answers: [{ finding_id: 'F1', kind: 'fixed', reply: 'Narrowed.', edits: [{ old: 'always switches in 200 ms', new: 'switches in a median of 200 ms' }], evidence_claim: null }] }
    }) as Paper['ask']
    await respond.ready(paper)[0].run()

    expect(asked.map((o) => o.light)).toEqual([false])
    const [f1, f2] = paper.state.findings
    expect(f1.status).toBe('fixed')
    expect([f2.status, f2.dispositions.length, f2.dispositions[1].kind]).toEqual(['open', 2, 'unanswered'])
    expect(respond.ready(paper).map((t) => t.key)).toEqual(['respond:F2.2'])
  })

  it('asks a verdict that cannot tell again at full effort, and sends the answer back when it still cannot tell', async () => {
    const paper = paperWith([finding('F1', 'always switches in 200 ms', [{ at: '', kind: 'fixed', text: 'Narrowed.', edits: [], family: 'claude' }], 'fixed')])
    const asked: { light?: boolean }[] = []
    paper.ask = (async (options: { light?: boolean }) => {
      asked.push(options)
      return { verdicts: [{ finding_id: 'F1', outcome: 'uncertain', reason: 'The change is not visible.' }] }
    }) as Paper['ask']
    const f = paper.state.findings[0]

    await verifyDisposition.ready(paper)[0].run()
    expect([f.status, resolved(f)]).toEqual(['fixed', false])
    await verifyDisposition.ready(paper)[0].run()
    expect(asked.map((o) => o.light)).toEqual([true, false])
    expect(f.status).toBe('open')
    expect(f.dispositions[0].verification).toMatchObject({ outcome: 'disagrees', rechecked: true })
  })

  it('asks again for a decision that does not land in the text, then states the finding as a limitation', async () => {
    const paper = paperWith([finding('F1', 'always switches in 200 ms', [rejected(), rejected(), rejected()])])
    const f = paper.state.findings[0]
    paper.ask = (async () => ({ decisions: [{ id: 'F1', decision: 'set_aside', reason: 'Out of scope.', edits: [], handled_by: 'A sentence the paper does not have.' }] })) as Paper['ask']
    await adjudicate.ready(paper)[0].run()
    expect(f.status).toBe('open')
    await adjudicate.ready(paper)[0].run()
    expect([adjudicate.ready(paper), f.status]).toEqual([[], 'open'])

    paper.ask = (async () => ({ sentence: 'The bench does not establish switching times beyond the trials it ran.', after: '' })) as Paper['ask']
    await handleFinding.ready(paper)[0].run()
    expect(paper.state.passages.S2.text).toBe('The bench used one vendor. The bench does not establish switching times beyond the trials it ran.')
    expect([f.status, f.adjudication?.fallback, resolved(f)]).toEqual(['adjudicated', true, true])
  })

  it('leaves a finding aside only on a person\'s decision', () => {
    const f = finding('F1', 'always switches in 200 ms', [], 'noted')
    expect(resolved(f)).toBe(false)
    expect(resolved({ ...f, assignee: 'humans' })).toBe(true)
  })
})
