// What reaches the printed page: a reference names its people one by one, an entity prints as its character, a
// hand-written citation link never breaks the typeset paper, prose never prints as code, and a unit prints as a unit.
import { describe, expect, it } from 'vitest'
import { formatResult } from '../../src/engine/analysis.js'
import { cleanCsl, cslFromWork } from '../../src/engine/evidence.js'
import { handLinks, unindent } from '../../src/engine/render.js'
import { citationKey, personNames } from '../../src/engine/text.js'
import type { Work } from '../../src/engine/types.js'

describe('the printed page', () => {
  it('names each person of a reference once, given name first, without affiliations', () => {
    const osti = ['Lundstrom, Blake R [National Renewable Energy Laboratory (NREL), Golden, CO (United States)]; Patel, Sourav [University of Minnesota]; Attree, Sandeep [University of Minnesota]; Salapaka, Murti V [University of Minnesota']
    expect(personNames(osti)).toEqual(['Blake R Lundstrom', 'Sourav Patel', 'Sandeep Attree', 'Murti V Salapaka'])
    expect(personNames(['Andrea Michiorri', 'Linder, Andreas', 'University of California, Berkeley'])).toEqual(['Andrea Michiorri', 'Andreas Linder', 'University of California, Berkeley'])
    const work: Work = { id: 'W1', doi: null, title: 'Fast Primary Frequency Response Using Coordinated DER', authors: osti, year: 2018, venue: null, abstract: '', citedBy: null, url: null }
    expect(citationKey(work, new Set())).toBe('lundstrom2018fast')
    expect(cslFromWork(work).author).toEqual([{ family: 'Lundstrom', given: 'Blake R' }, { family: 'Patel', given: 'Sourav' }, { family: 'Attree', given: 'Sandeep' }, { family: 'Salapaka', given: 'Murti V' }])
    // An entity a registry encoded twice prints as its character.
    expect(cleanCsl({ type: 'proceedings-article', 'container-title': 'Industrial and Commercial Power Systems Europe (EEEIC / I&amp;amp;CPS Europe)' })['container-title']).toBe('Industrial and Commercial Power Systems Europe (EEEIC / I&CPS Europe)')
  })

  it('prints a citation written by hand as a link as the citation it names, or as its words', () => {
    const known = new Set(['lundstrom2018fast'])
    expect(handLinks('within 143 ms ([Lundstrom et al. 2018](#ref-lundstrom2018fast)).', known)).toBe('within 143 ms [@lundstrom2018fast].')
    expect(handLinks('as [Lundstrom et al. 2018](#ref-lundstrom2018fast) show', known)).toBe('as @lundstrom2018fast show')
    expect(handLinks('within 143 ms ([Lundstrom et al. 2018](#ref-nosuchkey)).', known)).toBe('within 143 ms (Lundstrom et al. 2018).')
  })

  it('starts an indented paragraph at the margin, and keeps a fenced block as written', () => {
    expect(unindent('       Bench campaigns should carry the record.\n   \nNext paragraph.')).toBe('Bench campaigns should carry the record.\n\nNext paragraph.')
    expect(unindent('```\n    code stays\n```\n\n- a list\n    continues')).toBe('```\n    code stays\n```\n\n- a list\n    continues')
  })

  it('prints a unit as a unit, and keeps its qualifier with the method', () => {
    const r = formatResult({ name: 'M4_mean', value: 5834.820276497696, method: 'Observed summary of the retained records', unit: 'ms (label)', n: 217 } as never)
    expect(r.value).toBe('5,834.8 ms')
    expect(r.summary).toContain('unit: ms (label)')
  })
})
