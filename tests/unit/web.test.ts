// A claim the scholarly index has no source for gets a look at primary sources
// on the web: galley fetches and keeps the document itself, the passage must be
// verbatim from that copy, and the citation goes to verification like any other.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findWebSources } from '../../src/engine/behaviors/web.js'
import { verifyCitationsSettled } from '../../src/engine/behaviors/truth.js'
import { Paper } from '../../src/engine/paper.js'
import type { Claim } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { vi.unstubAllGlobals(); if (dir) rmSync(dir, { recursive: true, force: true }) })

const rule = 'The FFR provider shall activate the full contracted reserve within 0.7 seconds when the frequency falls to 49.5 Hz, and keep it for at least five seconds.'
const page = `<html><head><title>Technical requirements for Fast Frequency Reserve</title></head><body><h1>Technical requirements</h1><p>${'This document sets out the technical requirements and the prequalification process for reserve providers in the Finnish power system. '.repeat(6)}</p><p>${rule}</p></body></html>`

describe('primary sources from the web', () => {
  it('fetches the issuer\'s document, keeps a copy, and sends its verbatim passage to verification', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const paper = Paper.create(join(dir, 'p'), 'seed')
    const s = paper.state
    s.outline = { sections: [{ id: 'S1', title: 'Requirements', purpose: '', claimIds: ['C1'], words: 300, figureIds: [] }], style: '', glossary: [] }
    const c: Claim = { id: 'C1', text: 'The FFR product requires full activation within 0.7 s.', kind: 'background', seedQuote: '', origin: 'seed', need: 'external', loadBearing: true, dependsOn: [], status: 'unsupported', history: [] }
    s.claims = [c]
    expect(verifyCitationsSettled(paper, ['C1'])).toBe(false)

    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('wikipedia')
      ? new Response('no', { status: 200 })
      : new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })))
    const asked: { family: string; web?: boolean }[] = []
    paper.ask = (async (options: { family: string; web?: boolean; target: string }) => {
      asked.push({ family: options.family, web: options.web })
      return options.target.endsWith(':passages')
        ? { claims: [{ claim_id: 'C1', choices: [{ document: (await import('node:crypto')).createHash('sha256').update('https://www.fingrid.fi/ffr.html').digest('hex').slice(0, 8), passage: rule, fit: 'direct' }] }] }
        : { sources: [
          { claim_id: 'C1', url: 'https://www.fingrid.fi/ffr.html', title: 'Technical requirements for FFR', publisher: 'Fingrid', authority: 'the TSO that procures FFR', date: '2025' },
          { claim_id: 'C1', url: 'https://en.wikipedia.org/wiki/FFR', title: 'FFR', publisher: 'Wikipedia', authority: 'summary', date: '' },
        ] }
    }) as Paper['ask']
    await findWebSources.ready(paper)[0].run()

    expect(asked[0]).toEqual({ family: 'gpt', web: true })
    const work = Object.values(s.works).find((w) => w.id.startsWith('web:'))!
    expect(work).toMatchObject({ title: 'Technical requirements for FFR', url: 'https://www.fingrid.fi/ffr.html', venue: 'Fingrid' })
    expect(s.citations).toEqual([expect.objectContaining({ claimId: 'C1', workId: work.id, passage: rule, status: 'selected' })])
    expect(c.status).toBe('open')
    expect(s.attempts['web:C1']).toBe(1)
    expect(findWebSources.ready(paper)).toEqual([])
  })
})
