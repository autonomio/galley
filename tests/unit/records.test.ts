// A dataset given by its link: galley reads the Zenodo record for how to cite
// it, downloads its files and unpacks the archive, keeping data and README.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { datasetFromRecord, zenodoRecord } from '../../src/engine/records.js'

let dir = ''
afterEach(() => { vi.unstubAllGlobals(); if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('a dataset by its link', () => {
  it('recognises a Zenodo record by its page, its API address or its DOI', () => {
    expect(zenodoRecord('https://zenodo.org/records/19781923')).toBe('19781923')
    expect(zenodoRecord('https://doi.org/10.5281/zenodo.19781923')).toBe('19781923')
    expect(zenodoRecord('10.5281/zenodo.19781923')).toBe('19781923')
    expect(zenodoRecord('https://example.org/data')).toBeNull()
  })

  it('reads the record, downloads and unpacks its archive, and gives the dataset its reference', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const src = join(dir, 'src', 'VPP_Latency_Measurements-v1.0.1')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'delays.csv'), 'delay\n1\n2\n3\n')
    writeFileSync(join(src, 'README.md'), '# VPP latency measurements\n')
    writeFileSync(join(src, 'plot.png'), 'not kept')
    execFileSync('zip', ['-qr', '../archive.zip', '.'], { cwd: join(dir, 'src') })
    const archive = readFileSync(join(dir, 'archive.zip'))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/content')
      ? new Response(archive, { status: 200 })
      : new Response(JSON.stringify({
        id: 19781923, doi: '10.5281/zenodo.19781923',
        metadata: { title: 'ICTEnergyFTW/VPP_Latency_Measurements: Public DOI v2', version: 'v1.0.1', publication_date: '2026-04-26', license: { id: 'cc-by-4.0' }, creators: [{ name: 'ICTEnergyFTW' }], related_identifiers: [{ identifier: 'https://github.com/ICTEnergyFTW/VPP_Latency_Measurements/tree/v1.0.1', relation: 'isSupplementTo', resource_type: 'software' }] },
        files: [{ key: 'ICTEnergyFTW/VPP_Latency_Measurements-v1.0.1.zip', size: archive.length, links: { self: 'https://zenodo.org/api/records/19781923/files/archive.zip/content' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const manifest = await datasetFromRecord('https://zenodo.org/records/19781923', join(dir, 'inbox'))
    expect(manifest).toMatchObject({
      name: 'ICTEnergyFTW/VPP_Latency_Measurements: Public DOI v2', producedBy: 'others', version: 'v1.0.1', doi: '10.5281/zenodo.19781923',
      url: 'https://zenodo.org/records/19781923', licence: 'CC-BY-4.0', private: false,
      citation: 'ICTEnergyFTW (2026). ICTEnergyFTW/VPP_Latency_Measurements: Public DOI v2 (v1.0.1). Zenodo. https://doi.org/10.5281/zenodo.19781923',
    })
    expect(manifest.describedIn).toBeUndefined()
    expect(manifest.files.map((f) => basename(f)).sort()).toEqual(['README.md', 'delays.csv'])
  })
})
