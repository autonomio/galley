// The engine's rules that do not need a model: exact edits, verbatim checks,
// citation keys, placeholders, and a scheduler that never lets an improver
// stop the line.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Paper } from '../../src/engine/paper.js'
import { resetHintMs } from '../../src/engine/models.js'
import { fillPlaceholders, importEditorEdits } from '../../src/engine/render.js'
import { runPaper, Stalled, type Behavior } from '../../src/engine/scheduler.js'
import { obj, str } from '../../src/engine/schema.js'
import { applyExact, citationKey, dropUnknownCitations, escapeUnknownCitations, isVerbatim, overlap, sameClaim } from '../../src/engine/text.js'
import { resolved } from '../../src/engine/behaviors/review.js'
import { isNarrowing } from '../../src/engine/behaviors/truth.js'
import { LADDER } from '../../src/engine/behaviors/index.js'
import { DOES, systemBlock } from '../../src/engine/self.js'
import { cleanCsl, openalexKey, searchWait } from '../../src/engine/evidence.js'
import type { Citation, Finding } from '../../src/engine/types.js'
import { calibrationItems } from '../../src/engine/behaviors/close.js'
import { analyze, parseTable, profileDataset, profileText, type AnalysisSpec } from '../../src/engine/materials.js'

describe('text rules', () => {
  it('applies an edit only where its old text is unique', () => {
    expect(applyExact('a cat and a dog', { old: 'cat', new: 'fox' })).toBe('a fox and a dog')
    expect(applyExact('a cat and a cat', { old: 'cat', new: 'fox' })).toBeNull()
    expect(applyExact('one  two\nthree', { old: 'two three', new: '2 3' })).toBe('one  2 3')
    expect(applyExact('anything', { old: 'missing', new: 'x' })).toBeNull()
    // An edit quoting text that is not stored (a generated appendix, say) fails quietly, however long it is.
    expect(applyExact('short text', { old: `# Claim ledger ${'every claim [C1] (x) '.repeat(400)}`, new: 'y' })).toBeNull()
  })

  it('accepts a passage only when it is in the source', () => {
    const abstract = 'Here we show that “atypical” combinations   double the hit rate.'
    expect(isVerbatim('"atypical" combinations double the hit rate', abstract)).toBe(true)
    expect(isVerbatim('atypical combinations triple the hit rate', abstract)).toBe(false)
  })

  it('keeps prose when it drops citations to unknown keys', () => {
    const { text, dropped } = dropUnknownCitations('Hits mix the old and the new [@uzzi2013; @ghost2020]. As @ghost2021 argued.', new Set(['uzzi2013']))
    expect(text).toBe('Hits mix the old and the new [@uzzi2013]. As prior work argued.')
    expect(dropped).toEqual(['ghost2020', 'ghost2021'])
  })

  it('prints an @word that is no citation as text, so the PDF never breaks on it', () => {
    const known = new Set(['uzzi2013'])
    expect(escapeUnknownCitations('Keep it (@humans) or share it (@both); see @autonomio/galley. As [@uzzi2013] and @uzzi2013 show; `@autonomio/galley` is code; mail a@b.org.', known))
      .toBe('Keep it (\\@humans) or share it (\\@both); see \\@autonomio/galley. As [@uzzi2013] and @uzzi2013 show; `@autonomio/galley` is code; mail a@b.org.')
  })

  it('gives every work a distinct readable key', () => {
    const taken = new Set<string>()
    const work = { id: 'W1', doi: null, title: 'Atypical Combinations and Scientific Impact', authors: ['Brian Uzzi'], year: 2013, venue: null, abstract: '', citedBy: null, url: null }
    expect(citationKey(work, taken)).toBe('uzzi2013atypical')
    expect(citationKey(work, taken)).toBe('uzzi2013atypical2')
  })

  it('fills production placeholders and marks unknown ones', () => {
    const { text, unknown } = fillPlaceholders('It took {{run.calls}} calls and {{run.nope}}.', { 'run.calls': 42 })
    expect(text).toBe('It took 42 calls and [not recorded].')
    expect(unknown).toEqual(['run.nope'])
  })

  it('tells the same evidence request apart from a different claim', () => {
    const asked = 'Prior evaluations of LLM-generated research ideas have used blinded expert reviewers to score the novelty of AI-generated and human-written ideas on matched topics.'
    expect(sameClaim(asked, `${asked.slice(0, -1)}, with the ideas presented in a common format so that reviewers could not tell which was which.`)).toBe(true)
    expect(sameClaim(asked, 'The AI Scientist filters its own research ideas for novelty against retrieved literature before writing a paper.')).toBe(false)
    // Narrowing removes words from the claim; a "narrowed" claim about something else brings its own.
    expect(isNarrowing('Training cost varies substantially across configurations within commonly used HPO search spaces, for example with model width or depth, number of training epochs or dataset size.', 'Training cost varies across configurations in HPO, for example with model width.')).toBe(true)
    expect(isNarrowing('Papers that combine conventional and atypical references are more likely to be highly cited.', 'For publications below a citation crossover, the author\'s reputation dominates the annual citation rate.')).toBe(false)
  })

  it('writes strict schemas: closed objects, all properties required', () => {
    expect(obj({ a: str(), b: str() })).toMatchObject({ additionalProperties: false, required: ['a', 'b'] })
  })
})

describe('references', () => {
  it('keeps only standard CSL fields in standard shapes, so citeproc accepts a registry record', () => {
    const raw = { type: 'journal-article', title: ['Atypical Combinations'], 'container-title': ['Science'], ISSN: ['0036-8075', '1095-9203'], author: [{ family: 'Uzzi', given: 'Brian', sequence: 'first' }], published: { 'date-parts': [[2013, 10, 25]] }, reference: [{ key: 'x' }], link: [{ URL: 'y' }] }
    expect(cleanCsl(raw)).toEqual({ type: 'article-journal', title: 'Atypical Combinations', 'container-title': 'Science', ISSN: '0036-8075', author: [{ family: 'Uzzi', given: 'Brian' }], issued: { 'date-parts': [[2013, 10, 25]] } })
  })

  it('drops an affiliation listed as an author, unless no person is listed', () => {
    const author = [{ name: 'Department of Information and Library Science, Tamkang University' }, { family: 'Tsung-Ming', given: 'Hsiao' }]
    expect(cleanCsl({ type: 'proceedings-article', title: 'T', author }).author).toEqual([{ family: 'Tsung-Ming', given: 'Hsiao' }])
    expect(cleanCsl({ type: 'report', title: 'T', author: [{ name: 'World Health Organization' }] }).author).toEqual([{ literal: 'World Health Organization' }])
  })
})

describe('searching', () => {
  it('finds the OpenAlex key in ~/.env under either case, and reads nothing else', () => {
    const home = mkdtempSync(join(tmpdir(), 'galley-home-'))
    const saved = { HOME: process.env.HOME, KEY: process.env.OPENALEX_API_KEY }
    try {
      delete process.env.OPENALEX_API_KEY
      process.env.HOME = home
      expect(openalexKey()).toBeNull()
      writeFileSync(join(home, '.env'), "other_secret=nope\nopenalex_api_key='abc123'\n")
      expect(openalexKey()).toBe('abc123')
    } finally {
      process.env.HOME = saved.HOME
      if (saved.KEY) process.env.OPENALEX_API_KEY = saved.KEY
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('waits exactly as long as the index asks, else backs off to at most five minutes while nothing comes back', () => {
    expect(searchWait(0, 90_000)).toBe(91_000)
    expect(searchWait(6, 32_000)).toBe(33_000)
    expect(searchWait(1, 0)).toBe(60_000)
    expect(searchWait(2, 0)).toBe(120_000)
    expect(searchWait(9, 0)).toBe(300_000)
  })
})

describe('materials', () => {
  const spec = (over: Partial<AnalysisSpec>): AnalysisSpec => ({ id: 'A1', dataset: 'M1', op: 'mean', column: null, column2: null, by: null, value: null, where: null, ...over })

  it('reads quoted fields and tabs, and profiles a dataset without showing any row of it', () => {
    const rows = parseTable('name,arm,score\n"Doe, Jane",treatment,4\nJohn Roe,control,2\nAda Poe,treatment,6\nBo Loe,control,3\n')
    expect(rows[0]).toEqual({ name: 'Doe, Jane', arm: 'treatment', score: '4' })
    expect(parseTable('a\tb\n1\t2\n')).toEqual([{ a: '1', b: '2' }])
    const text = profileText(profileDataset(rows))
    expect(text).toContain('4 rows, 3 columns')
    expect(text).toContain('score (number): mean 3.75')
    expect(text).toContain('arm (category): 2 distinct values: treatment (2), control (2)')
    expect(text).not.toContain('Jane')
  })

  it('computes the analyses a paper cites, matching textbook values', () => {
    const rows = [1, 2, 3, 4, 5].map((x) => ({ g: 'a', x: String(x), y: '' })).concat([3, 4, 5, 6, 7].map((x) => ({ g: 'b', x: String(x), y: '' })))
    // Welch's t for 1..5 against 3..7: t = -2, df = 8, two-sided p = 0.0805.
    expect(analyze(rows, spec({ op: 'mean_difference', column: 'x', by: 'g', value: 'a|b' })).summary).toContain('Welch t = -2.00, df = 8.0, p = 0.081')
    const xy = [[1, 2], [2, 4], [3, 5], [4, 4], [5, 5]].map(([x, y]) => ({ x: String(x), y: String(y) }))
    expect(analyze(xy, spec({ op: 'correlation', column: 'x', column2: 'y' })).summary).toContain('r = 0.775, n = 5')
    expect(analyze(rows, spec({ op: 'proportion', column: 'g', value: 'a' })).value).toBe('50%')
    expect(analyze(rows, spec({ op: 'mean', column: 'x', where: { column: 'g', op: 'eq', value: 'b' } })).value).toBe('5')
    expect(analyze(rows, spec({ op: 'mean', column: 'nope' })).error).toBeTruthy()
  })
})

describe('verifier calibration', () => {
  it('plants mismatches, overclaims and controls from as few as two verified citations, and never pairs a claim with its own passage as a mismatch', () => {
    const cite = (id: string, claimId: string, workId: string) => ({ id, claimId, workId, passage: `passage ${id}`, role: 'support', status: 'verified', chosenBy: 'auto' }) as unknown as Citation
    const items = calibrationItems([cite('K1', 'C1', 'W1'), cite('K2', 'C2', 'W2')], (id) => `Claim ${id}.`)
    expect(items.map((i) => i.kind)).toEqual(['mismatch', 'mismatch', 'mismatch', 'overclaim', 'overclaim', 'overclaim', 'control', 'control'])
    for (const item of items.filter((i) => i.kind === 'mismatch')) expect(item.claim).not.toBe(`Claim ${item.cite.claimId}.`)
    expect(calibrationItems([cite('K1', 'C1', 'W1')], () => 'x')).toEqual([])
  })
})

describe('the referee loop', () => {
  it('counts an answered finding as settled only once the referee who raised it has judged the answer', () => {
    const finding = { severity: 'material', status: 'fixed', dispositions: [{ at: '', kind: 'fixed', text: 'done', edits: [], family: 'claude' }] } as unknown as Finding
    expect(resolved(finding)).toBe(false)
    finding.dispositions[0].verification = { outcome: 'verified', reason: 'yes', family: 'gpt' }
    expect(resolved(finding)).toBe(true)
    expect(resolved({ ...finding, status: 'open' })).toBe(false)
  })
})

describe('self-description', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('describes every behavior of the ladder a run executes, with its seats', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    paper.ladder = LADDER.map(({ id, stage, improver, title }) => ({ id, stage, improver, title }))
    paper.state.brief = { hasSubject: true, concern: '', contribution: '', objectType: 'capability', field: '', audience: '', aboutSystem: false }
    expect(systemBlock(paper)).toBe('')
    paper.state.brief.aboutSystem = true
    const block = systemBlock(paper)
    for (const b of LADDER) expect(DOES[b.id], b.id).toBeTruthy()
    expect(block).toContain(`The ladder (${LADDER.length} behaviors`)
    expect(block).toContain('author Claude Opus 5.5 (claude-opus-5-5)')
    expect(block).toContain('MIT licence, source at https://github.com/autonomio/galley')
  })
})

describe('the editor round trip', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('turns what a person changed in the editor into their revision, and leaves the rest alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed', { authors: [{ name: 'Ada' }], editorDir: join(dir, 'p', 'editor') })
    const s = paper.state
    s.frame = { title: 'T', abstract: 'A.', keywords: [], limitations: '', opens: '' }
    s.outline = { sections: [{ id: 'S1', title: 'One', purpose: '', claimIds: [], words: 1, figureIds: [] }, { id: 'S2', title: 'Two', purpose: '', claimIds: [], words: 1, figureIds: [] }], style: '', glossary: [] }
    const passage = (id: string, text: string) => ({ sectionId: id, text, revisions: [], checked: 'faithful' as const })
    s.passages = { S1: passage('S1', 'First.\n\n## Sub\n\nMore.'), S2: passage('S2', 'Second.') }
    s.editorBase = { title: 'T', abstract: 'A.', S1: s.passages.S1.text, S2: s.passages.S2.text }
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(paper.path('editor'), { recursive: true })
    writeFileSync(paper.path('editor', 'p.md'), '# T\n\n## Abstract\n\nA.\n\n## One\n\nFirst, changed by hand.\n\n### Sub\n\nMore.\n\n## Two\n\nSecond.\n')
    expect(importEditorEdits(paper)).toEqual(['S1'])
    expect(s.passages.S1.text).toBe('First, changed by hand.\n\n## Sub\n\nMore.')
    expect(s.passages.S1.revisions.at(-1)?.by).toEqual({ kind: 'human', name: 'Ada' })
    expect(s.passages.S2.revisions).toEqual([])
  })
})

describe('scheduler', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('settles a failing improver as skipped and keeps going', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const ran: string[] = []
    let skipped = false
    const flaky: Behavior = {
      id: 'flaky', stage: 'truth', improver: true, title: 'fails',
      ready: (p) => [{ key: 'flaky:1', label: 'x', run: async () => { ran.push('flaky'); throw new Error('nope') }, skip: () => { skipped = true } }],
    }
    const after: Behavior = {
      id: 'after', stage: 'skeleton', improver: false, title: 'runs anyway',
      ready: (p) => p.isSettled('flaky:1') ? [{ key: 'after:1', label: 'y', run: async () => { ran.push('after') } }] : [],
    }
    await runPaper(paper, [flaky, after], { log: () => {} })
    expect(ran).toEqual(['flaky', 'flaky', 'after'])
    expect(skipped).toBe(true)
    expect(paper.state.settled).toEqual({ 'flaky:1': 'skipped', 'after:1': 'done' })
    expect(paper.state.notes[0].text).toMatch(/skipped after 2 attempts/)
  })

  it('pauses, resumably, when a required behavior keeps failing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const broken: Behavior = {
      id: 'broken', stage: 'skeleton', improver: false, title: 'fails',
      ready: () => [{ key: 'broken:1', label: 'x', run: async () => { throw new Error('down') } }],
    }
    await expect(runPaper(paper, [broken], { log: () => {} })).rejects.toBeInstanceOf(Stalled)
    expect(Paper.open(join(dir, 'p')).isSettled('broken:1')).toBe(false)
  })
})

describe('provider limits', () => {
  it('reads when a quota resets from the limit message', () => {
    expect(resetHintMs('gemini: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 27m56s." error: Individual quota reached.')).toBe((27 * 60 + 56) * 1000)
    expect(resetHintMs('Resets in 1h2m')).toBe(62 * 60_000)
    expect(resetHintMs('resets in 45s')).toBe(45_000)
    expect(resetHintMs('usage limit reached; try later')).toBeNull()
  })
})
