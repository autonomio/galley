// A dataset is a unit of one or more files with where it comes from; its
// provenance decides how the paper describes and cites it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { citableKeys } from '../../src/engine/behaviors/common.js'
import { addDatasets, availabilityStatement, materialsBlock } from '../../src/engine/materials.js'
import { Paper } from '../../src/engine/paper.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('datasets', () => {
  it('takes several files in as one dataset, and has the paper describe and cite data others produced as theirs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const files = join(dir, 'in')
    mkdirSync(files)
    writeFileSync(join(files, 'trees.csv'), `id,site,alive\n${Array.from({ length: 30 }, (_, i) => `${i},${i % 2 ? 'pit' : 'park'},${i % 3 ? 'yes' : 'no'}`).join('\n')}\n`)
    writeFileSync(join(files, 'README.md'), '# Street trees\nSurvival by site type, 2018 to 2024.\n')
    const out = join(dir, 'p')
    const { materials, datasets } = await addDatasets(out, [{ name: 'Street trees', files: [join(files, 'trees.csv'), join(files, 'README.md')], producedBy: 'others', doi: 'https://doi.org/10.5281/zenodo.123', version: '1.0.1' }])

    expect(datasets).toEqual([expect.objectContaining({ id: 'D1', name: 'Street trees', producedBy: 'others', doi: '10.5281/zenodo.123', version: '1.0.1', private: true, materials: ['M1', 'M2'] })])
    expect(materials.map((m) => [m.id, m.kind, m.dataset])).toEqual([['M1', 'dataset', 'D1'], ['M2', 'document', 'D1']])

    const paper = Paper.create(out, 'seed', { materials, datasets })
    const block = materialsBlock(paper)
    expect(block).toContain('produced by others')
    expect(block).toMatch(/cite the dataset as \[@[^\]]+\]/)
    expect(block).not.toContain("authors' own work")
    expect(availabilityStatement(paper)).toContain('was produced by others. It is available at https://doi.org/10.5281/zenodo.123')
    expect(citableKeys(paper).size).toBe(1)
  })
})
