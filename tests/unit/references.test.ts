// A reference prints as the publication it is: a chapter in its book and series, a paper in its proceedings with the
// series volume once, and a preprint as a preprint.
import { describe, expect, it } from 'vitest'
import { cleanCsl, refineFromCrossref, refineFromDatacite } from '../../src/engine/evidence.js'

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

  it('cites an arXiv record as a preprint, whatever type its registry gave it', () => {
    const clean = cleanCsl({ type: 'article-journal', title: 'Broken Neural Scaling Laws', 'container-title': 'arXiv', publisher: 'arXiv', DOI: '10.48550/ARXIV.2210.14891' })
    expect(clean).toMatchObject({ type: 'article', publisher: 'arXiv' })
    expect(clean['container-title']).toBeUndefined()
  })
})
