// One ladder, two branches: a thesis run takes the rungs it shares with a paper and its own three; from the stance the
// person chose it formulates a thesis once the literature is in, tests it, formulates it again once if it misses, and
// writes the brief into the document it started from.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keyFor } from '../../src/engine/behaviors/common.js'
import { aimSettled } from '../../src/engine/behaviors/front.js'
import { LADDER } from '../../src/engine/behaviors/index.js'
import { formulateThesis, testThesis, thesisBrief } from '../../src/engine/behaviors/thesis.js'
import { liveView } from '../../src/engine/live.js'
import { Paper } from '../../src/engine/paper.js'

// The search for work already stating the thesis finds one work: the closest its test is checked against.
vi.mock('../../src/engine/evidence.js', async (original) => ({
  ...(await original<typeof import('../../src/engine/evidence.js')>()),
  canarySearch: vi.fn(async () => ({ t0q1: { results: [{ id: 'W9', doi: '10.1/roots', title: 'Roots cross pavements', year: 2019, venue: null, type: null, authors: ['Ann Root'], abstract: 'Roots of street trees cross under pavements.', oa: null, url: null }] } })),
}))
import { syncEditor } from '../../src/engine/render.js'
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
    // A registry can write a name family first.
    s.works.W1 = { id: 'W1', doi: '10.1/pits', title: 'Narrow pits shorten tree lives', authors: ['Roe, Jane'], year: 2020, venue: 'Urban Forestry', abstract: '', citedBy: null, url: null }
    s.claims.push({ id: 'C1', text: 'Narrow pits shorten the lives of street trees.', kind: 'background', seedQuote: '', origin: 'review', need: 'external', loadBearing: false, dependsOn: [], status: 'supported', history: [] })
    s.citations.push({ id: 'K1', claimId: 'C1', workId: 'W1', passage: 'Trees in narrow pits died sooner.', role: 'support', status: 'verified', chosenBy: 'auto' })
    // A deposited dataset carries its authors and year only in its citation data, and a title can end in a footnote mark.
    s.works.D1 = { id: 'D1', doi: '10.5281/zenodo.1', title: 'Root survey of one street †', authors: [], year: null, venue: null, abstract: '', citedBy: null, url: null, csl: { author: [{ family: 'TreeLab' }], issued: { 'date-parts': [[2025, 4]] } } }
    const key = keyFor(paper, s.works.W1)
    const survey = keyFor(paper, s.works.D1)
    const asked: { behavior: string; target: string; prompt: string }[] = []
    const verdicts = [false, true]
    paper.ask = (async (options: { behavior: string; target: string; prompt: string }) => {
      asked.push(options)
      if (options.behavior === 'formulate') return {
        positions: [{ name: 'Pit engineering', holds: 'Bigger pits save trees.', rests_on: 'The pit is the unit that matters.', sources: [key] }],
        shared_assumption: `The single tree is the unit of care (@${key}).`, set_aside: 'Smaller pits save trees.',
        thesis: options.target === 'thesis' ? 'Street trees are best treated as a network.' : 'Street trees live or die as one shared root network.',
        title: 'Street trees as one network', relation: 'It leaves the pit for the network the roots form.',
        conditions: [{ statement: 'Roots cross from pit to pit', status: 'unknown', sources: [survey] },{ statement: 'Narrow pits shorten tree lives', status: 'supported', sources: [key] }],
        depends_on: [`Roots reach across pavements, as shown by ${key}.`], decides: 'A survey of roots under one street.', opens: 'Planting for the network.', residue: '', novelty_queries: ['roots across pits'],
      }
      return { passes: verdicts.shift(), objections: ['It is the opposite of pit engineering.'], already: [], closest: [{ title: 'Roots cross pavements', differs: 'It follows single roots, not the network they form.' }, { title: 'A work the search never found', differs: 'Left out.' }] }
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
    expect(brief).toContain('- **Pit engineering.** Bigger pits save trees. It rests on the assumption that the pit is the unit that matters (Roe 2020).')
    expect(brief).toContain('- Narrow pits shorten tree lives (Roe 2020). *supported*')
    expect(brief).toContain('- Roots cross from pit to pit (TreeLab 2025). *not yet known*')
    expect(brief).toContain('- Jane Roe (2020). Narrow pits shorten tree lives. Urban Forestry. https://doi.org/10.1/pits')
    expect(brief).toContain('- TreeLab (2025). Root survey of one street. https://doi.org/10.5281/zenodo.1')
    // A key written into the text reads as the work's authors and year; the raw key never shows.
    expect(brief).toContain('What every position takes for granted: The single tree is the unit of care (Roe 2020).')
    expect(brief).toContain('- Roots reach across pavements, as shown by (Roe 2020).')
    expect(brief).not.toContain(key)
    // What its novelty was checked against: the closest work found, dated and linked from the search's own record.
    expect(brief).toContain('The closest work the search found, and how the thesis differs from it:\n\n- Roots cross pavements (2019). It follows single roots, not the network they form. https://doi.org/10.1/roots')
    expect(brief).not.toContain('A work the search never found')
    expect(asked[0].prompt).toContain('never the seed\'s question or aim restated')
    expect(brief).toContain('not a systematic review in the formal sense')
    expect(readFileSync(join(dir, 'editor', 'trees.md'), 'utf8')).toBe(brief)
  })

  it('shows a thesis beside the page as a thesis: named from its seed, then by its own title, and ready once its brief is written', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), '# Street trees\n\nCity trees die young.', { mode: 'thesis', stance: 'reframe', literatureReview: true })
    expect(liveView(join(dir, 'p'))).toMatchObject({ mode: 'thesis', title: 'Street trees', ready: false, stage: { id: 'seed', label: 'Seed' } })
    paper.state.thesis = {
      stance: 'reframe', statement: 'Street trees live or die as one shared root network.', title: 'Street trees as one network', relation: '', positions: [], sharedAssumption: '', setAside: '',
      conditions: [], dependsOn: [], decides: '', opens: '', residue: '', noveltyQueries: [], revision: 0, test: { passes: true, objections: [], already: [], family: 'gemini' },
    }
    paper.state.outcome = 'thesis_ready'
    paper.save()
    const view = liveView(join(dir, 'p'))!
    expect(view).toMatchObject({ title: 'Street trees as one network', ready: true, stage: { id: 'brief', label: 'Brief' } })
    expect(view.notes.find((n) => n.key === 'ready')?.text).toBe('The brief is in the document, with a PDF beside it.')
    expect(view.notes.at(-1)?.text).not.toContain('run it again')
  })

  it('writes the brief into the document once: the seed and its notes stay until then, and what the person changes is never lost', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const editor = join(dir, 'editor')
    const doc = join(editor, 'trees.md')
    const notes = '{"annotations":[{"id":"n1"}]}'
    mkdirSync(editor)
    writeFileSync(doc, 'City trees die young.')
    writeFileSync(join(editor, 'trees.annotations.json'), notes)
    const paper = Paper.create(join(dir, 'p'), 'City trees die young.', { mode: 'thesis', stance: 'extend', literatureReview: true, editorDir: editor, editorDoc: 'trees', authors: [{ name: 'Ada Lovelace' }] })
    syncEditor(paper)
    expect(readFileSync(join(editor, 'trees.annotations.json'), 'utf8')).toBe(notes)
    // The person changes the seed while the thesis is formulated: the brief replaces it, and their version is kept.
    writeFileSync(doc, 'City trees die young, and fast.')
    mkdirSync(paper.path('out'))
    writeFileSync(paper.path('out', 'thesis.md'), '# Street trees as one network\n')
    paper.state.outcome = 'thesis_ready'
    syncEditor(paper)
    expect(readFileSync(doc, 'utf8')).toBe('# Street trees as one network\n')
    expect(readFileSync(paper.path('document.before-brief.md'), 'utf8')).toBe('City trees die young, and fast.')
    expect(readFileSync(paper.path('seed.annotations.json'), 'utf8')).toBe(notes)
    expect(existsSync(join(editor, 'trees.annotations.json'))).toBe(false)
    // Once delivered, the brief is the person's: a later run leaves their edits as they are.
    writeFileSync(doc, '# Street trees as one shared network\n')
    syncEditor(paper)
    expect(readFileSync(doc, 'utf8')).toBe('# Street trees as one shared network\n')
  })
})
