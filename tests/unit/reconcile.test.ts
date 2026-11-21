// The ledger against the final text: a claim held twice is kept once, and plain-text mathematics is typeset.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reconcile, sameWords } from '../../src/engine/behaviors/close.js'
import { Paper } from '../../src/engine/paper.js'
import type { Claim } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const claim = (id: string, status: Claim['status'], text: string): Claim => ({ id, text, kind: 'background', seedQuote: '', origin: 'system', need: 'external', loadBearing: false, dependsOn: [], status, history: [] })

describe('reconciling the ledger', () => {
  it('keeps the stronger of two claims that say the same, and typesets mathematics without changing a word', async () => {
    expect(sameWords('a tree T_A of rows', 'a tree $T_A$ of rows') && sameWords('soft choice <1-p, p>', 'soft choice $\\langle 1-p, p \\rangle$')).toBe(true)
    expect(sameWords('a tree T_A of rows', 'a forest $T_A$ of rows')).toBe(false)
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const s = paper.state
    s.claims = [claim('C16', 'unsupported', 'Training evaluates the full tree.'), claim('C39', 'supported', 'During training every node mixes both children, so the full tree is evaluated.'), claim('C12', 'supported', 'It takes O(r·ham(T_A)) time given a tree T_A.')]
    s.claims[2].dependsOn = ['C16']
    s.citations = [{ id: 'X1', claimId: 'C16', workId: 'W1', passage: 'p', status: 'verified' } as Paper['state']['citations'][number]]
    s.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: [] }], style: '', glossary: [] }
    s.passages = { S1: { sectionId: 'S1', text: 'The full tree is evaluated in training.', revisions: [], checked: 'faithful' } }
    s.frame = { title: 'T', abstract: 'A', keywords: [], limitations: '', opens: '' }
    s.round = paper.config.rounds
    paper.settle('named:works', 'done')
    paper.settle('copyedit:text', 'done')
    paper.ask = (async () => ({ items: [
      { claim_id: 'C16', how: 'stated', quote: 'q', narrowed: null, duplicate_of: 'C39', typeset: null },
      { claim_id: 'C39', how: 'stated', quote: 'q', narrowed: null, duplicate_of: 'C16', typeset: null },
      { claim_id: 'C12', how: 'stated', quote: 'q', narrowed: null, duplicate_of: null, typeset: 'It takes $O(r \\cdot \\mathrm{ham}(T_A))$ time given a tree $T_A$.' },
    ] })) as Paper['ask']
    await reconcile.ready(paper)[0].run()
    expect(s.claims.map((c) => [c.id, c.status])).toEqual([['C16', 'dropped'], ['C39', 'supported'], ['C12', 'supported']])
    expect(s.claims[2].text).toBe('It takes $O(r \\cdot \\mathrm{ham}(T_A))$ time given a tree $T_A$.')
    expect(s.claims[2].dependsOn).toEqual(['C39'])
    expect(s.citations[0].claimId).toBe('C39')
  })
})
