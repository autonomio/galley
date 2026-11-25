// Every defect a reading of the typeset paper finds goes to a part of the
// engine that can fix it: how a table or figure sits on its page, a part the
// system prints from its records, an author's name in the references. And the
// paper is called ready only when nothing a reader would see is left open.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ready } from '../../src/engine/behaviors/close.js'
import { proof } from '../../src/engine/behaviors/proof.js'
import { reviewAppendix } from '../../src/engine/literature.js'
import { Paper } from '../../src/engine/paper.js'
import { contentHash, fitTables, tableKey } from '../../src/engine/render.js'
import type { Work } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

/** A paper whose review is done and whose typeset revision waits to be read. */
function toRead(text = 'Table 1 and Figure 1 show the delays.'): Paper {
  dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
  const paper = Paper.create(join(dir, 'p'), 'seed')
  const s = paper.state
  s.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: [] }], style: '', glossary: [] }
  s.passages = { S1: { sectionId: 'S1', text, revisions: [], checked: 'faithful' } }
  s.frame = { title: 'T', abstract: 'A', keywords: [], limitations: '', opens: '' }
  s.round = paper.config.rounds
  paper.settle('frame:final', 'done')
  paper.settle('story:read:3', 'done')
  paper.settle(`typeset:${contentHash(paper)}`, 'done')
  return paper
}

describe('a defect goes to what can fix it', () => {
  it('sets a table or figure that does not fit its page one step further, and calls the paper ready only when nothing a reader would see is left', async () => {
    const paper = toRead()
    const s = paper.state
    s.figures = [{ id: 'F1', caption: 'Delays by stage.', spec: '', sectionId: 'S1', status: 'rendered', file: 'figures/F1.png', source: '#text[delays]' }]
    paper.settle(`typeset:${contentHash(paper)}`, 'done')
    const header = '| Stage | Source series | Record count |'
    const table = `${header}\n|:--|:--|--:|\n| PSU | G1 | 24 |\n\n: The delays.`
    mkdirSync(paper.path('out'), { recursive: true })
    writeFileSync(paper.path('out', 'manuscript.md'), `# Results\n\nTable 1 and Figure 1 show the delays.\n\n${table}\n`)
    paper.ask = (async (o: { seat: string }) => o.seat === 'checker'
      ? { defects: [
        { page: 13, where: 'table', quote: 'Table 1', problem: 'Headers collide across columns.', fix: 'Fit the table to its page.', severity: 'P1', fix_in: 'layout' },
        // Classed as neither, a caption apart from its table is still how the table sits on its page.
        { page: 13, where: 'table', quote: 'Table 1', problem: 'The caption is separated from the table.', fix: 'Keep them together.', severity: 'P1', fix_in: 'other' },
        { page: 16, where: 'figure', quote: 'Figure 1', problem: 'The caption runs past the bottom of the page.', fix: 'Fit it to the page.', severity: 'P1', fix_in: 'layout' },
        { page: 20, where: 'references', quote: 'Feng et al.', problem: 'The entry runs on onto the next page.', fix: 'Keep it on one page.', severity: 'P3', fix_in: 'other' },
      ] }
      : { corrections: [] }) as Paper['ask']
    await proof.ready(paper)[0].run()

    // One step for the table, however many defects name it: smaller type, then a landscape page.
    expect(s.layout).toEqual({ tables: { [tableKey(header)]: 1 }, figures: { F1: 1 } })
    expect(s.proof).toMatchObject({ fixed: 3 })
    expect(s.proof!.left.map((d) => d.severity)).toEqual(['P3'])
    expect(fitTables(table, s.layout!.tables)).toContain('#show table: set text(size: 7.5pt)')
    expect(fitTables(table, { [tableKey(header)]: 2 })).toMatch(/^```\{=typst\}\n#page\(flipped: true\)\[\n#\[\n[\s\S]*: The delays\.\n\n```\{=typst\}\n\]\n\]\n```$/)
    expect(fitTables(table)).not.toContain('{=typst}')

    // Read on this revision with only a matter of taste left, the paper is ready.
    const finish = async () => {
      const hash = contentHash(paper)
      for (const key of [`typeset:${hash}`, `proof:${hash}`, 'reprofile:final']) paper.settle(key, 'done')
      await ready.ready(paper)[0].run()
      return s.outcome
    }
    expect(await finish()).toBe('ready_for_submission')
    // With an error a reader would see still open, the run ends all the same, and says so.
    s.outcome = undefined
    s.proof!.left.push({ page: 13, where: 'table', quote: 'Table 1', problem: 'Headers collide.', fix: 'Fit it.', by: 'reader', severity: 'P1' })
    expect(await finish()).toBe('finished_with_open_defects')
  })

  it('writes a part the system prints from its records again from them, as another family checks it', async () => {
    const paper = toRead('The delays are as recorded.')
    const s = paper.state
    const quote = 'No generic battery context padding.'
    s.literature = {
      question: 'How fast do telecom power supplies activate?', status: 'done', searchedOn: '2026-11-22', included: [],
      protocol: { concepts: [], queries: ['psu activation'], eligibility: { core: 'Bench tests of PSU switching; identify single-unit tests separately.', supporting: 'Grid codes.', exclusion: quote } },
      counts: { discovered: 10, screened: 5, retrieved: 4, reviewed: 3, core: 2, supporting: 1, cited: 1, queries: 1, findings: 2, audited: 2, minutes: 5 },
    }
    const rewritten = '**Eligibility.** Core studies were bench tests of power supply switching, with single-unit tests identified separately. Supporting studies were grid codes. Studies of batteries in general were excluded.'
    const asks: string[] = []
    paper.ask = (async (o: { target: string }) => {
      asks.push(o.target.replace(/^[0-9a-f]{16}/, 'hash'))
      if (o.target.endsWith(':check')) return { faithful: true, problem: '' }
      if (o.target.includes(':block:')) return { text: rewritten }
      return { defects: [{ page: 19, where: 'appendix', quote, problem: 'An instruction to the screening agent is printed among the eligibility rules.', fix: 'Report the rule.', severity: 'P0', fix_in: 'prose' }] }
    }) as Paper['ask']
    await proof.ready(paper)[0].run()

    // Not sent to the last section printed before it, whose author could not find the words: written again from its records.
    expect(asks).toEqual(['hash', 'hash:block:review-eligibility', 'hash:block:review-eligibility:check'])
    expect(s.proof).toMatchObject({ fixed: 1, left: [] })
    expect(reviewAppendix(paper, (id) => id, null)).toContain(rewritten)
    // Written for these records only: once they change, the system's own text prints again.
    s.literature.protocol!.eligibility.exclusion = 'Studies of batteries alone.'
    expect(reviewAppendix(paper, (id) => id, null)).toContain('Excluded: Studies of batteries alone.')
  })

  it('corrects an author\'s name in the references only with name parts the paper\'s records hold', async () => {
    const paper = toRead('The delays are as recorded.')
    const s = paper.state
    const work = (id: string, key: string, author: { given: string; family: string }[]): Work => ({ id, doi: null, title: key, authors: author.map((a) => `${a.given} ${a.family}`), year: 2020, venue: null, abstract: '', citedBy: null, url: null, bibKey: key, csl: { type: 'paper-conference', title: key, author } })
    s.works = {
      W1: work('W1', 'yimei2020delay', [{ given: 'Zhang', family: 'Yimei' }, { given: 'Dong', family: 'Chaoyu' }]),
      W2: work('W2', 'dong2020distorted', [{ given: 'Chaoyu', family: 'Dong' }]),
    }
    mkdirSync(paper.path('build'), { recursive: true })
    writeFileSync(paper.path('build', 'refs.json'), JSON.stringify(Object.values(s.works).map((w) => ({ id: w.bibKey, type: 'paper-conference', author: w.csl!.author }))))
    paper.ask = (async (o: { seat: string }) => o.seat === 'checker'
      ? { defects: [
        { page: 26, where: 'references', quote: 'Yimei, Zhang, and Dong Chaoyu', problem: 'The author list mixes name order.', fix: 'Print each name as the Dong et al. entry does.', severity: 'P1', fix_in: 'other' },
        { page: 27, where: 'references', quote: 'Dong, Chaoyu', problem: 'The name is printed in two forms.', fix: 'Print it one way.', severity: 'P1', fix_in: 'other' },
      ] }
      : { corrections: [
        { defect: 1, id: 'yimei2020delay', set: [], remove: [], authors: [{ family: 'Zhang', given: 'Yimei' }, { family: 'Dong', given: 'Chaoyu' }] },
        // A name no record holds is never set.
        { defect: 2, id: 'dong2020distorted', set: [], remove: [], authors: [{ family: 'Dongson', given: 'Chaoyu' }] },
      ] }) as Paper['ask']
    await proof.ready(paper)[0].run()

    expect(s.works.W1.csl!.author).toEqual([{ family: 'Zhang', given: 'Yimei' }, { family: 'Dong', given: 'Chaoyu' }])
    expect(s.works.W1.corrected).toEqual(['set author'])
    expect(s.works.W2.csl!.author).toEqual([{ given: 'Chaoyu', family: 'Dong' }])
    expect(s.proof!.left.map((d) => d.quote)).toEqual(['Dong, Chaoyu'])
  })
})
