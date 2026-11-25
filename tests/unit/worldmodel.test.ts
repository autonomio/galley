// A world model as a paper's sources: a Resolvent repository is read once, its
// passages are searched for every claim, one paper's passages are one work, and
// with only the world model nothing else is searched.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { briefBlock } from '../../src/engine/behaviors/common.js'
import { findEvidence, verify } from '../../src/engine/behaviors/truth.js'
import { Paper } from '../../src/engine/paper.js'
import type { Claim } from '../../src/engine/types.js'
import { doiOfUri, JOIN, keepWorldModel, readWorldModel, searchable, searchWorldModel, type WorldModel } from '../../src/engine/worldmodel.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'galley-test-')) })
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })

const MODEL: WorldModel = {
  name: 'attention-model', sha256: 'abc',
  claims: [
    { id: 'C-1', statement: 'Approximate attention needs nearly quadratic time unless its entries are bounded.', uncertainty: 'low', evidence_ids: ['E-1'], state: 'active' },
    { id: 'C-2', statement: 'Structured matrices cut the cost of training dense layers.', uncertainty: 'medium', evidence_ids: ['E-2'], state: 'active' },
    { id: 'C-3', statement: 'A retired claim about attention.', evidence_ids: ['E-1'], state: 'retired' },
  ],
  evidence: [
    { id: 'E-1', summary: 'A conditional lower bound for approximate attention.', source_ids: ['S-a', 'S-b'], independent: true },
    { id: 'E-2', summary: 'Monarch matrices train faster.', source_ids: ['S-c'] },
  ],
  sources: [
    { id: 'S-a', kind: 'publication', title: 'Fast Attention Requires Bounded Entries', uri: 'https://arxiv.org/pdf/2302.13214', date: '2023-01-01', excerpt: 'Assuming SETH, approximate attention computation requires nearly quadratic time when the entries are large.', openalex: 'W1' },
    { id: 'S-b', kind: 'publication', title: 'Fast Attention Requires Bounded Entries', uri: 'https://arxiv.org/pdf/2302.13214', date: '2023-01-01', excerpt: 'When the entries are bounded, attention can be approximated in almost linear time.' },
    { id: 'S-c', kind: 'publication', title: 'Monarch: Expressive Structured Matrices', uri: 'https://doi.org/10.5555/Monarch.2022', date: '2022-01-01', excerpt: 'Monarch matrices speed up the end-to-end training of dense models by a factor of two.' },
  ],
  graph: [],
}

const external = (id: string, text: string): Claim => ({ id, text, kind: 'background', seedQuote: '', origin: 'system', need: 'external', loadBearing: false, dependsOn: [], status: 'open', history: [] })

describe('a world model as the sources', () => {
  it('cites one paper once, with all its passages, and finds a DOI where the address carries one', () => {
    const m = searchable(MODEL)
    const [first, ...rest] = searchWorldModel(m, 'approximate attention needs quadratic time unless entries are bounded', 5)
    expect(first).toMatchObject({ id: 'S-a', doi: '10.48550/arxiv.2302.13214', year: 2023 })
    // Both passages of the paper, the one that matched best first.
    expect(first.abstract).toBe(`${MODEL.sources[1].excerpt}${JOIN}${MODEL.sources[0].excerpt}`)
    expect(rest.map((h) => h.id)).not.toContain('S-b')
    expect([doiOfUri('https://dl.acm.org/doi/pdf/10.1145/3510003.3510109'), doiOfUri('https://www.nature.com/articles/s41586-021-03819-2'), doiOfUri('https://doi.org/10.5555/Monarch.2022')])
      .toEqual(['10.1145/3510003.3510109', null, '10.5555/monarch.2022'])
  })

  it('with only the world model, searches nothing else and copies each passage from a source\'s excerpt', async () => {
    const paper = Paper.create(join(dir, 'p'), 'seed', { worldModel: keepWorldModel(join(dir, 'p'), MODEL, true), literatureReview: true })
    expect([paper.config.literatureReview, paper.config.webSources]).toEqual([false, false])
    paper.state.outline = { sections: [], style: '', glossary: [] }
    paper.state.claims = [external('C1', 'Approximate attention needs nearly quadratic time unless its entries are bounded.')]
    const prompts: string[] = []
    paper.ask = (async (options: { prompt: string }) => {
      prompts.push(options.prompt)
      return { claims: [{ claim_id: 'C1', choices: [{ work_id: 'S-a', passage: 'When the entries are bounded, attention can be approximated in almost linear time.', fit: 'narrower', role: 'support', note: '' }] }] }
    }) as Paper['ask']
    await findEvidence.ready(paper)[0].run()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('EXCERPT: Assuming SETH')
    expect(paper.state.citations).toEqual([expect.objectContaining({ claimId: 'C1', workId: 'S-a', status: 'selected' })])
    expect(briefBlock(paper)).toContain('THE WORLD MODEL the paper\'s sources come from: "attention-model"')
    expect(briefBlock(paper)).not.toContain('A retired claim')

    // Before it is judged, the work gets its authors from its DOI's record.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'article', title: 'Fast Attention Requires Bounded Entries', author: [{ given: 'Josh', family: 'Alman' }, { given: 'Zhao', family: 'Song' }], issued: { 'date-parts': [[2023]] } }))))
    let judged = ''
    paper.ask = (async (options: { prompt: string }) => { judged = options.prompt; return { items: [] } }) as Paper['ask']
    await verify.ready(paper)[0].run()
    expect(judged).toContain('WORK: Josh Alman, Zhao Song (2023). Fast Attention Requires Bounded Entries.')
  })

  it('reads a Resolvent repository given as a zip: only its records, with PyYAML\'s safe loader', async () => {
    const root = join(dir, 'attention-model-main')
    const write = (path: string, text: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }
    write('claims/C-1.yaml', 'id: C-1\nclass: derived_inference\nstatement: Approximate attention needs nearly quadratic time unless its\n  entries are bounded.\nuncertainty: low\nevidence_ids:\n- E-1\nstate: active\n')
    write('evidence/E-1.yaml', 'id: E-1\nkind: external\nsummary: A conditional lower bound.\nsource_ids:\n- S-a\nindependent: true\n')
    write('sources/S-a.yaml', 'id: S-a\nkind: publication\ntitle: Fast Attention Requires Bounded Entries\nuri: https://arxiv.org/pdf/2302.13214\ndate: \'2023-01-01\'\nlocator: \'{"paper_metadata_id": "W4321", "page": 13}\'\nexcerpt: "Theorem 4.6. Assuming SETH,\\\n  \\ attention requires\\nquadratic time."\naccess: inspected\n')
    write('scripts/run.py', 'raise SystemExit("never run")\n')
    execFileSync('zip', ['-qr', join(dir, 'attention-model-main.zip'), 'attention-model-main'], { cwd: dir })
    const model = await readWorldModel(join(dir, 'attention-model-main.zip'))
    expect(model.name).toBe('attention-model')
    expect(model.claims).toEqual([expect.objectContaining({ id: 'C-1', statement: 'Approximate attention needs nearly quadratic time unless its entries are bounded.', uncertainty: 'low' })])
    expect(model.sources[0]).toMatchObject({ id: 'S-a', date: '2023-01-01', openalex: 'W4321', excerpt: 'Theorem 4.6. Assuming SETH, attention requires quadratic time.' })
  }, 600_000)
})
