// One ladder, two branches: a thesis run takes the rungs it shares with a paper and its own three; from the stance the
// person chose it formulates a thesis once the literature is in, tests it, formulates it again once if it misses, and
// writes the brief into the document it started from.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { keyFor } from '../../src/engine/behaviors/common.js'
import { aimSettled } from '../../src/engine/behaviors/front.js'
import { LADDER } from '../../src/engine/behaviors/index.js'
import { formulateThesis, testThesis, thesisBrief } from '../../src/engine/behaviors/thesis.js'
import { Paper } from '../../src/engine/paper.js'
import { branch } from '../../src/engine/scheduler.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('the thesis branch', () => {
  it('runs one ladder: a thesis takes the rungs it shares with a paper and its own, a paper all the rest', () => {
    expect(branch(LADDER, 'thesis').map((b) => b.id)).toEqual(['extract', 'position', 'literature-review', 'formulate', 'test-thesis', 'thesis-brief'])
    const paper = branch(LADDER).map((b) => b.id)
    expect(paper).toHaveLength(LADDER.length - 3)
    expect(paper).not.toContain('formulate')
    expect(paper.slice(0, 3)).toEqual(['extract', 'position', 'review-idea'])
  })

  it('formulates a thesis from its stance once the literature is in, tests it, formulates it again once when it misses, and writes the brief', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'City trees die young in narrow pavement pits.', {
      mode: 'thesis', stance: 'reframe', literatureReview: true, editorDir: join(dir, 'editor'), editorDoc: 'trees', authors: [{ name: 'Ada Lovelace' }],
    })
    const s = paper.state
    s.brief = { hasSubject: true, concern: 'Street trees die young.', contribution: '', objectType: 'finding', field: 'urban forestry', audience: '', aboutSystem: false }
    paper.settle('position:seed', 'done')
    expect(aimSettled(paper)).toBe(true)
    // The thesis takes its stance against what the field holds, so it waits for the literature.
    s.literature = { question: 'How do street trees die?', status: 'running' }
    expect(formulateThesis.ready(paper)).toEqual([])
    s.literature = { question: 'How do street trees die?', status: 'done', searchedOn: '2026-11-22', counts: { discovered: 1200, screened: 80, retrieved: 40, reviewed: 30, core: 20, supporting: 10, cited: 5, queries: 6, findings: 1, audited: 1, minutes: 30 }, gaps: ['No study follows roots across pits.'] }
    s.works.W1 = { id: 'W1', doi: '10.1/pits', title: 'Narrow pits shorten tree lives', authors: ['Jane Roe'], year: 2020, venue: 'Urban Forestry', abstract: '', citedBy: null, url: null }
    s.claims.push({ id: 'C1', text: 'Narrow pits shorten the lives of street trees.', kind: 'background', seedQuote: '', origin: 'review', need: 'external', loadBearing: false, dependsOn: [], status: 'supported', history: [] })
    s.citations.push({ id: 'K1', claimId: 'C1', workId: 'W1', passage: 'Trees in narrow pits died sooner.', role: 'support', status: 'verified', chosenBy: 'auto' })
    const key = keyFor(paper, s.works.W1)
    const asked: { behavior: string; target: string; prompt: string }[] = []
    const verdicts = [false, true]
    paper.ask = (async (options: { behavior: string; target: string; prompt: string }) => {
      asked.push(options)
      if (options.behavior === 'formulate') return {
        positions: [{ name: 'Pit engineering', holds: 'Bigger pits save trees.', rests_on: 'the pit being the unit that matters', sources: [key] }],
        shared_assumption: 'The single tree is the unit of care.', set_aside: 'Smaller pits save trees.',
        thesis: options.target === 'thesis' ? 'Street trees are best treated as a network.' : 'Street trees live or die as one shared root network.',
        title: 'Street trees as one network', relation: 'It leaves the pit for the network the roots form.',
        conditions: [{ statement: 'Roots cross from pit to pit', status: 'unknown', sources: [] }, { statement: 'Narrow pits shorten tree lives', status: 'supported', sources: [key] }],
        depends_on: ['Roots reach across pavements.'], decides: 'A survey of roots under one street.', opens: 'Planting for the network.', residue: '', novelty_queries: [],
      }
      return { passes: verdicts.shift(), objections: ['It is the opposite of pit engineering.'], already: [] }
    }) as Paper['ask']

    await formulateThesis.ready(paper)[0].run()
    expect(asked[0].prompt).toContain('Your stance is reframe')
    expect(asked[0].prompt).toContain(`Narrow pits shorten the lives of street trees. @${key}`)
    expect(asked[0].prompt).toContain('No study follows roots across pits.')

    await testThesis.ready(paper)[0].run()
    expect(asked.map((a) => `${a.behavior}:${a.target}`)).toEqual(['formulate:thesis', 'test-thesis:revision-0', 'formulate:revision-1', 'test-thesis:revision-1'])
    expect(asked[2].prompt).toContain('It is the opposite of pit engineering.')
    expect(s.thesis).toMatchObject({ statement: 'Street trees live or die as one shared root network.', revision: 1, setAside: 'Smaller pits save trees.', test: { passes: true, revisedFrom: 'Street trees are best treated as a network.' } })

    await thesisBrief.ready(paper)[0].run()
    expect(s.outcome).toBe('thesis_ready')
    const brief = readFileSync(paper.path('out', 'thesis.md'), 'utf8')
    expect(brief).toMatch(/^# Street trees as one network\n\nAda Lovelace · /)
    expect(brief).toContain('**Thesis.** Street trees live or die as one shared root network.')
    expect(brief).toContain('**Stance.** Reframe: it goes beyond what the field holds, onto another axis.')
    expect(brief).toContain('- Narrow pits shorten tree lives (Roe 2020). *supported*')
    expect(brief).toContain('- Jane Roe (2020). Narrow pits shorten tree lives. Urban Forestry. https://doi.org/10.1/pits')
    expect(brief).toContain('not a systematic review in the formal sense')
    expect(readFileSync(join(dir, 'editor', 'trees.md'), 'utf8')).toBe(brief)
  })
})
