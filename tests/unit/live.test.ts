// The live view a host draws beside the editor: read from a paper's files alone.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { liveView } from '../../src/engine/live.js'
import { Paper } from '../../src/engine/paper.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('liveView', () => {
  it('says who is working on what, where the paper stands, and what has happened', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-live-'))
    const paper = Paper.create(join(dir, 'Seed-Paper'), 'seed', {})
    const s = paper.state
    s.brief = { hasSubject: true, concern: 'c', contribution: 'k', objectType: 'finding', field: 'Ecology', audience: 'a' }
    s.plan = { thesis: 't', workingTitle: 'Pit Size and Tree Survival', noun: 'n', opens: [], objectType: 'finding' }
    s.outline = { sections: [{ id: 'S1', title: 'Introduction', purpose: '', claimIds: [], words: 1, figureIds: [] }], style: '', glossary: [] }
    paper.save()
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    for (const e of [
      { at: at(9), event: 'call', behavior: 'outline', seat: 'author', family: 'claude', model: 'claude-opus-5-5' },
      { at: at(8), event: 'settled', behavior: 'outline', target: 'outline:paper', how: 'done' },
      { at: at(2), event: 'human_edits', sections: ['title'] },
    ]) appendFileSync(paper.path('journal.jsonl'), JSON.stringify(e) + '\n')
    // A run in progress: this process stands in for it.
    writeFileSync(paper.path('progress.json'), JSON.stringify({ pid: process.pid, outcome: null, inFlight: [{ behavior: 'draft', target: 'S1', what: 'claude-opus-5-5 (author)', started: at(1) }] }))

    const view = liveView(paper.dir)!
    expect(view.doc).toBe('seed-paper')
    expect(view.title).toBe('Pit Size and Tree Survival')
    expect(view.running).toBe(true)
    expect(view.stage).toEqual({ id: 'evidence', label: 'Evidence' })
    expect(view.now).toEqual([expect.objectContaining({ seat: 'author', name: 'Author', family: 'claude', doing: 'drafting Introduction', section: 'S1' })])
    expect(view.team.slice(0, 4).map((m) => [m.seat, m.family])).toEqual([['author', 'claude'], ['checker', 'gpt'], ['challenger', 'gemini'], ['verifier', 'gemini']])
    expect(view.sections).toEqual([{ id: 'S1', title: 'Introduction', written: false }])
    expect(view.notes.map((n) => n.key)).toEqual(['seed', 'evidence', 'claims', 'sections'])
    expect(view.activity.map((e) => [e.name, e.text])).toEqual([
      ['You', 'started the paper from your seed.'],
      ['Author', 'outlined 1 section.'],
      ['You', 'edited the title.'],
    ])
  })

  it('is null for a folder that holds no paper', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-live-'))
    expect(liveView(dir)).toBeNull()
  })
})
