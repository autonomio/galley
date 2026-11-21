// The whole text is read once for consistency, and each fix lands in the section or caption it belongs to.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyedit } from '../../src/engine/behaviors/copyedit.js'
import { STORY_STEPS } from '../../src/engine/behaviors/story.js'
import { reconcile } from '../../src/engine/behaviors/close.js'
import { datedIn } from '../../src/engine/behaviors/web.js'
import { Paper } from '../../src/engine/paper.js'
import { conventions } from '../../src/engine/render.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('the copyedit', () => {
  it('reads the whole text after the named works are cited and the paper is told, fixes sections and captions, and holds the ledger until then', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const s = paper.state
    s.outline = { sections: [{ id: 'S1', title: 'Model', purpose: '', claimIds: [], words: 300, figureIds: [] }, { id: 'S2', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: ['F1'] }], style: '', glossary: [] }
    s.passages = {
      S1: { sectionId: 'S1', text: 'Each draw is one pair of tasks.', revisions: [], checked: 'faithful' },
      S2: { sectionId: 'S2', text: 'Over the 20,000 task draws, the tilt is positive.', revisions: [], checked: 'faithful' },
    }
    s.figures = [{ id: 'F1', caption: 'The null prices tasks with a dense gradient-descent cost.', spec: '', sectionId: 'S2', status: 'rendered', file: 'figures/F1.png' }]
    s.frame = { title: 'T', abstract: 'A', keywords: [], limitations: '', opens: '' }
    s.round = paper.config.rounds
    expect(copyedit.ready(paper)).toEqual([])
    paper.settle('named:works', 'done')
    // It reads the text as told.
    expect(copyedit.ready(paper)).toEqual([])
    for (const step of STORY_STEPS) paper.settle(step.key, 'done')
    expect(reconcile.ready(paper)).toEqual([])
    paper.ask = (async (options: { seat: string }) => options.seat === 'checker'
      ? { problems: [
        { where: ['[S2]', 'S1'], quote: 'the 20,000 task draws', problem: 'Each draw is a pair of tasks.', fix: 'the 20,000 pair draws' },
        { where: ['F1'], quote: 'dense gradient-descent cost', problem: 'The null is a synthetic cost model.', fix: 'basis-neutral synthetic cost model' },
        { where: ['S9'], quote: 'x', problem: 'not a section of this paper', fix: '' },
      ] }
      : { edits: [
        { in: 'S2', old: 'the 20,000 task draws', new: 'the 20,000 pair draws' },
        { in: 'F1', old: 'a dense gradient-descent cost', new: 'a basis-neutral synthetic cost model' },
        { in: 'S1', old: 'not in the text', new: 'x' },
      ] }) as Paper['ask']
    await copyedit.ready(paper)[0].run()
    expect(s.passages.S2.text).toBe('Over the 20,000 pair draws, the tilt is positive.')
    expect(s.passages.S1.text).toBe('Each draw is one pair of tasks.')
    expect(s.figures[0].caption).toBe('The null prices tasks with a basis-neutral synthetic cost model.')
    paper.settle('copyedit:text', 'done')
    expect(reconcile.ready(paper).map((t) => t.key)).toEqual(['reconcile:ledger'])
  })

  it('prints numbered statements, noun citations and sized delimiters by the house conventions', () => {
    expect(conventions('**Definition 7** (Concordance). A method concordant with **Definition 1 (Chart).** Next.'))
      .toBe('**Definition 7 (Concordance).** A method concordant with **Definition 1 (Chart).** Next.')
    expect(conventions('as summarized in [@nist2026], following [@kearns1998], and shown [@a; @b] or in [@c, p. 3].'))
      .toBe('as summarized in @nist2026, following @kearns1998, and shown [@a; @b] or in [@c, p. 3].')
    expect(conventions('$\\log_2\\bigl(B(A) + \\lambda Q(A)\\bigr)$ and $\\big| x \\big|$ and $\\bigcup_i A_i$'))
      .toBe('$\\log_2\\left(B(A) + \\lambda Q(A)\\right)$ and $| x |$ and $\\bigcup_i A_i$')
  })

  it('takes a web page as dated in the year it was read only when it gives a full date in that year', () => {
    expect(datedIn('Updated: March 3, 2026. Kendall tau', 2026)).toBe(true)
    expect(datedIn('Published 2026-02-11', 2026)).toBe(true)
    expect(datedIn('© 2026 NIST. Kendall tau is a rank correlation.', 2026)).toBe(false)
  })
})
