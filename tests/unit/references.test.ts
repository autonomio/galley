// A reference prints as the publication it is: a chapter in its book and series, a paper in its proceedings with the
// series volume once, a preprint as a preprint, a thesis as a thesis, and a formula in a title as the formula.
import { describe, expect, it, vi } from 'vitest'
import { cleanCsl, completeByTitle, cslFromWork, refineFromCrossref, refineFromDatacite, texToCsl } from '../../src/engine/evidence.js'
import type { Work } from '../../src/engine/types.js'

describe('reference records', () => {
  it('names the book a chapter is in beside its series', () => {
    const csl: Record<string, unknown> = { type: 'book-chapter', title: 'Synthesis with Asymptotic Resource Bounds', 'container-title': 'Lecture Notes in Computer Science', page: '783-807', source: 'Crossref' }
    refineFromCrossref(csl, { type: 'book-chapter', 'container-title': ['Lecture Notes in Computer Science', 'Computer Aided Verification'] })
    expect(cleanCsl(csl)).toMatchObject({ type: 'chapter', 'container-title': 'Computer Aided Verification', 'collection-title': 'Lecture Notes in Computer Science' })
    // A journal article's single container is left as it is.
    const article: Record<string, unknown> = { type: 'journal-article', 'container-title': 'Journal of the ACM', volume: '66' }
    refineFromCrossref(article, { type: 'journal-article', 'container-title': ['Journal of the ACM'] })
    expect(cleanCsl(article)).toMatchObject({ type: 'article-journal', 'container-title': 'Journal of the ACM', volume: '66' })
  })

  it('prints a paper in proceedings in the proceedings, with the series volume once', () => {
    const csl: Record<string, unknown> = { type: '', 'container-title': 'LIPIcs, Volume 102, CCC 2018', volume: '102', number: '5', page: '5:1-5:31' }
    refineFromDatacite(csl, {
      types: { resourceTypeGeneral: 'ConferencePaper', citeproc: '' },
      relatedItems: [
        { relationType: 'IsPublishedIn', relatedItemType: 'ConferenceProceeding', titles: [{ title: 'LIPIcs, Volume 102, CCC 2018' }, { title: '33rd Computational Complexity Conference (CCC 2018)', titleType: 'Subtitle' }], volume: '102', firstPage: '5:1', lastPage: '5:31' },
        { relationType: 'IsPublishedIn', relatedItemType: 'Collection', titles: [{ title: 'Leibniz International Proceedings in Informatics (LIPIcs)' }], volume: '102' },
      ],
    })
    const clean = cleanCsl(csl)
    expect(clean).toMatchObject({ type: 'paper-conference', 'container-title': '33rd Computational Complexity Conference (CCC 2018)', 'collection-title': 'Leibniz International Proceedings in Informatics (LIPIcs)', 'collection-number': '102', page: '5:1-5:31' })
    expect(clean.volume).toBeUndefined()
    expect(clean.number).toBeUndefined()
    // Without the registry's record, a container title that states the volume still prints it once.
    expect(cleanCsl({ type: 'article-journal', 'container-title': 'LIPIcs, Volume 50, CCC 2016', volume: '50' }).volume).toBeUndefined()
  })

  it('prints a title with its subtitle, and a paper in proceedings by its year alone', () => {
    const clean = cleanCsl({ type: 'proceedings-article', title: 'Pebbles, Graphs, and a Pinch of Combinatorics', subtitle: ['Towards Tight I/O Lower Bounds for Statically Analyzable Programs'], 'container-title': 'Proceedings of the 33rd ACM Symposium on Parallelism in Algorithms and Architectures', issued: { 'date-parts': [[2021, 7, 6]] } })
    expect(clean).toMatchObject({ type: 'paper-conference', title: 'Pebbles, Graphs, and a Pinch of Combinatorics: Towards Tight I/O Lower Bounds for Statically Analyzable Programs', issued: { 'date-parts': [[2021]] } })
    // A journal article keeps its full date, and a title that already holds its subtitle is left as it is.
    expect(cleanCsl({ type: 'journal-article', title: 'Fast Learning Requires Good Memory: A Time-Space Lower Bound', subtitle: ['A Time-Space Lower Bound'], issued: { 'date-parts': [[2018, 12, 12]] } })).toMatchObject({ title: 'Fast Learning Requires Good Memory: A Time-Space Lower Bound', issued: { 'date-parts': [[2018, 12, 12]] } })
  })

  it('prints the TeX of a title as the formula it is, and a thesis under its one author', () => {
    expect(cleanCsl({ type: 'proceedings-article', title: 'Matching the Statistical Query Lower Bound for $k$-Sparse Parity Problems' }).title).toBe('Matching the Statistical Query Lower Bound for <i>k</i>-Sparse Parity Problems')
    expect(texToCsl('Learning with $\\tilde{O}(d^{k-1})$ samples and $2^{\\Theta(k)}$ neurons')).toBe('Learning with <i>Õ</i>(<i>d</i><sup><i>k</i>−1</sup>) samples and 2<sup>Θ(<i>k</i>)</sup> neurons')
    expect(texToCsl('An $\\Omega(n \\log n)$ bound in $\\mathrm{GF}(2)$')).toBe('An Ω(<i>n</i> log <i>n</i>) bound in GF(2)')
    expect(texToCsl('No formula here: 5$ and 6$, a $5 fee and $3 tax')).toBe('No formula here: 5$ and 6$, a $5 fee and $3 tax')
    expect(cleanCsl({ type: 'dissertation', title: 'Kolmogorov Complexity and Derandomization', author: [{ family: 'Ronneburger', given: 'Detlef' }, { family: 'Allender', given: 'Eric' }] }).author).toEqual([{ family: 'Ronneburger', given: 'Detlef' }])
  })

  it('completes a stub by its title from the record that says where the work was published, whatever year it carries', async () => {
    const records = [
      { doi: null, display_name: 'ImageNet classification with deep convolutional neural networks', publication_year: 2012, type: 'article', cited_by_count: 53884, authorships: [{ author: { display_name: 'Krizhevsky' } }], primary_location: { source: null } },
      { doi: 'https://doi.org/10.1145/3065386', display_name: 'ImageNet classification with deep convolutional neural networks', publication_year: 2017, type: 'article', cited_by_count: 118216, authorships: [{ author: { display_name: 'Alex Krizhevsky' } }, { author: { display_name: 'Ilya Sutskever' } }, { author: { display_name: 'Geoffrey E. Hinton' } }], primary_location: { source: { display_name: 'Communications of the ACM' } } },
      { doi: 'https://doi.org/10.9999/other', display_name: 'ImageNet classification with deep convolutional neural networks', publication_year: 2019, type: 'article', cited_by_count: 3, authorships: [{ author: { display_name: 'Someone Else' } }], primary_location: { source: { display_name: 'Elsewhere' } } },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: records }))))
    const stub: Work = { id: 'W3147600416', doi: null, title: 'ImageNet classification with deep convolutional neural networks', authors: ['Krizhevsky'], year: 2012, venue: null, abstract: '', citedBy: null, url: 'https://openalex.org/W3147600416' }
    expect(await completeByTitle(stub)).toBe(true)
    // The record by the same first author with a DOI, not the stub of the same year, nor one by someone else.
    expect(stub).toMatchObject({ doi: '10.1145/3065386', authors: ['Alex Krizhevsky', 'Ilya Sutskever', 'Geoffrey E. Hinton'], venue: 'Communications of the ACM' })

    // A record with no DOI still says what it is, where it was written and where it is held.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [{ doi: null, display_name: 'Kolmogorov complexity and derandomization', publication_year: 2004, type: 'dissertation', cited_by_count: 8, authorships: [{ author: { display_name: 'Detlef Ronneburger' }, institutions: [{ display_name: 'Rutgers, The State University of New Jersey' }] }], primary_location: { landing_page_url: 'http://dl.acm.org/citation.cfm?id=1087202', source: null } }] }))))
    const thesis: Work = { id: 'W138632766', doi: null, title: 'Kolmogorov complexity and derandomization', authors: ['Detlef Ronneburger', 'Eric Allender'], year: 2004, venue: null, abstract: '', citedBy: null, url: 'https://openalex.org/W138632766' }
    expect(await completeByTitle(thesis)).toBe(true)
    expect(thesis).toMatchObject({ kind: 'thesis', institution: 'Rutgers, The State University of New Jersey', url: 'http://dl.acm.org/citation.cfm?id=1087202' })
    expect(cleanCsl(cslFromWork(thesis))).toMatchObject({ type: 'thesis', author: [{ family: 'Ronneburger', given: 'Detlef' }] })
    vi.unstubAllGlobals()
  })

  it('cites an arXiv record as a preprint, whatever type its registry gave it', () => {
    const clean = cleanCsl({ type: 'article-journal', title: 'Broken Neural Scaling Laws', 'container-title': 'arXiv', publisher: 'arXiv', DOI: '10.48550/ARXIV.2210.14891' })
    expect(clean).toMatchObject({ type: 'article', publisher: 'arXiv' })
    expect(clean['container-title']).toBeUndefined()
  })
})
