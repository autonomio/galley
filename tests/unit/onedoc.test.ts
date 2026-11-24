// One document, one project: the paper is written into the document it started
// from, by its exact name, and the seed's notes move into the project with it.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Paper } from '../../src/engine/paper.js'
import { syncEditor } from '../../src/engine/render.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('one document per project', () => {
  it('writes the paper over the seed in the same document, and moves the seed\'s notes into the project', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const docs = join(dir, 'docs')
    const blurb = 'Street trees in narrow pits die young.\n'
    const note = { annotations: [{ id: 'n1', range: { start: { line: 0, ch: 0 }, end: { line: 0, ch: 12 } }, snippet: 'Street trees', comment: 'Is this true everywhere?', created_at: '2026-11-19T00:00:00Z', updated_at: '2026-11-19T00:00:00Z' }] }
    const paper = Paper.create(join(dir, 'papers', 'Street-Trees'), blurb, { editorDir: docs, editorDoc: 'Street-Trees' })
    // The document as the person left it: the blurb and a note on it, saved a while ago.
    mkdirSync(docs, { recursive: true })
    writeFileSync(join(docs, 'Street-Trees.md'), blurb)
    writeFileSync(join(docs, 'Street-Trees.annotations.json'), JSON.stringify(note))
    const past = new Date(Date.now() - 60_000)
    for (const f of ['Street-Trees.md', 'Street-Trees.annotations.json']) utimesSync(join(docs, f), past, past)

    syncEditor(paper)

    expect(readdirSync(docs).filter((f) => f.endsWith('.md'))).toEqual(['Street-Trees.md'])
    expect(readFileSync(join(docs, 'Street-Trees.md'), 'utf8')).toBe('# Untitled paper\n')
    expect(JSON.parse(readFileSync(join(docs, 'Street-Trees.annotations.json'), 'utf8')).annotations).toEqual([])
    expect(JSON.parse(readFileSync(paper.path('seed.annotations.json'), 'utf8'))).toEqual(note)
    expect(paper.state.findings.filter((f) => f.origin === 'human')).toEqual([])
  })
})
