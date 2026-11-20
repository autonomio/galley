// A work the text names is cited where it is named, or put on the sign-off sheet.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { citeAt, citeNamed, plausible, sentenceAround } from '../../src/engine/behaviors/named.js'
import { Paper } from '../../src/engine/paper.js'
import type { Work } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const work = (id: string, author: string, year: number, title: string): Work => ({ id, doi: null, title, authors: [author], year, venue: null, abstract: '', citedBy: null, url: null })
const works = [
  work('W1', 'Samuel S. Wilks', 1941, 'Determination of sample sizes for setting tolerance limits'),
  work('W2', 'Pouya Dehghankar', 2024, 'An Efficient Matrix Multiplication Algorithm for Accelerating Inference'),
  work('W3', 'Pouya Dehghankar', 2026, 'RSR-core: A High-Performance Engine for Low-Bit Matrix-Vector Multiplication'),
]

describe('works the text names', () => {
  it('takes as candidates only works by the named author within a year of the name', () => {
    const named = { section: 'S1', quote: 'Dehghankar et al. (2025)', authors: ['Dehghankar'], year: 2025, title: '' }
    expect(works.filter((w) => plausible(named, w)).map((w) => w.id)).toEqual(['W2', 'W3'])
    expect(works.filter((w) => plausible({ ...named, authors: ['Wilks'], year: 1941 }, w)).map((w) => w.id)).toEqual(['W1'])
  })

  it('reads the sentence a name stands in', () => {
    expect(sentenceAround('First point. As Wilks (1941) showed, n = 59. Next point.', 'Wilks (1941)')).toBe('As Wilks (1941) showed, n = 59.')
  })

  it('cites a name where it stands, keeping its words', () => {
    expect(citeAt('As Wilks (1941) showed, n = 59.', 'Wilks (1941)', 'wilks1941')).toBe('As Wilks [-@wilks1941] showed, n = 59.')
    expect(citeAt('JCGM 100:2008 defines it.', 'JCGM 100:2008', 'jcgm2008')).toBe('JCGM 100:2008 [@jcgm2008] defines it.')
    expect(citeAt('Nothing here.', 'Wilks (1941)', 'wilks1941')).toBeNull()
    // A reference in parentheses of its own becomes the citation, its typed-out details left to the reference list.
    expect(citeAt('upper limits (Wilks, 1941, Ann. Math. Stat. 12(1), 91–96). Next', 'Wilks, 1941', 'wilks1941')).toBe('upper limits [@wilks1941]. Next')
    expect(citeAt('the order statistic (Wilks, 1941). Each', '(Wilks, 1941)', 'wilks1941')).toBe('the order statistic [@wilks1941]. Each')
    expect(citeAt('limits (Wilks, 1941; see also Massart, 1990).', 'Wilks, 1941', 'wilks1941')).toBe('limits (Wilks, 1941 [@wilks1941]; see also Massart, 1990).')
    // A reference in parentheses after a method's name, even when the name was copied without its closing parenthesis.
    expect(citeAt('the SSR comparison (Pittet et al. 2026, October manuscript) claims', 'SSR comparison (Pittet et al. 2026, October manuscript)', 'pittet2026', 'Pittet')).toBe('the SSR comparison [@pittet2026] claims')
    expect(citeAt('Spectra packing (Vaidhya et al. 2025) is lossless', 'Spectra packing (Vaidhya et al. 2025', 'vaidhya2025', 'Vaidhya')).toBe('Spectra packing [@vaidhya2025] is lossless')
    expect(citeAt('by Dehghankar, Erfanian and Asudeh (2025 revision) as premises', 'Dehghankar, Erfanian and Asudeh (2025 revision)', 'dehghankar2024', 'Dehghankar')).toBe('by Dehghankar, Erfanian and Asudeh [-@dehghankar2024] as premises')
  })

  it('cites what it holds after review, and lists what it cannot find for the sign-off', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const s = paper.state
    paper.config.off = ['find-evidence']
    s.outline = { sections: [{ id: 'S1', title: 'Methods', purpose: '', claimIds: [], words: 300, figureIds: [] }], style: '', glossary: [] }
    s.passages = { S1: { sectionId: 'S1', text: 'Following Wilks (1941) and JCGM 100:2008, we bound the quantile.', revisions: [], checked: 'faithful' } }
    s.frame = { title: 'T', abstract: 'A', keywords: [], limitations: '', opens: '' }
    s.round = paper.config.rounds
    // A held work by the same surname and year on another subject is never cited for the name: the model names the work it means.
    s.works = { W1: works[0], W9: work('W9', 'Alisson Wilks', 1941, 'Lettuce yield under organic compost') }
    paper.ask = (async () => ({ named: [
      { section: '[S1]', quote: 'Wilks (1941)', authors: ['Wilks'], year: 1941, title: '', id: 'W1' },
      { section: 'S1', quote: 'JCGM 100:2008', authors: ['JCGM'], year: 2008, title: 'Guide to the expression of uncertainty in measurement', id: '' },
    ] })) as Paper['ask']
    await citeNamed.ready(paper)[0].run()
    expect(s.passages.S1.text).toMatch(/^Following Wilks \[-@\w+\] and JCGM 100:2008, we bound/)
    expect(s.named).toEqual([expect.objectContaining({ workId: 'W1', placed: true })])
    expect(s.unreferenced).toEqual([{ quote: 'JCGM 100:2008', sectionId: 'S1' }])
  })
})
