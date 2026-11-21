// A referee's finding is a thread in the editor. galley marks the thread resolved
// once the author answers; if the referee then rejects the answer, the finding goes
// back to the agents. Only a person resolving the thread hands it to people.
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Paper } from '../../src/engine/paper.js'
import { syncEditor } from '../../src/engine/render.js'
import type { Finding } from '../../src/engine/types.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const thread = (notesPath: string) => JSON.parse(readFileSync(notesPath, 'utf8')).annotations.find((a: { id: string }) => a.id === 'galley-F1')

describe('referee threads in the editor', () => {
  it('reopens a finding whose answer the referee rejects, and leaves it to people only when a person resolves it', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    const docs = join(dir, 'docs')
    const paper = Paper.create(join(dir, 'papers', 'trees'), 'seed', { editorDir: docs, editorDoc: 'trees' })
    const s = paper.state
    s.outline = { sections: [{ id: 'S1', title: 'Results', purpose: '', claimIds: [], words: 300, figureIds: [] }], style: '', glossary: [] }
    s.passages = { S1: { sectionId: 'S1', text: 'Every pit under two cubic metres loses its tree within ten years.', revisions: [], checked: 'faithful' } }
    const finding: Finding = {
      id: 'F1', round: 1, seat: 'methods', family: 'gpt', model: 'gpt-6.2-sol', severity: 'material', sectionId: 'S1', quote: 'loses its tree within ten years',
      question: 'Is every pit really lost?', alternatives: '', evidence: '', decision: 'narrow it', edit: null, status: 'fixed', assignee: 'agents', origin: 'agent',
      dispositions: [{ at: new Date().toISOString(), kind: 'fixed', text: 'Narrowed to most pits.', edits: [], family: 'claude' }],
    }
    s.findings = [finding]
    const notesPath = join(docs, 'trees.annotations.json')

    // Answered: galley marks the thread resolved.
    syncEditor(paper)
    expect(thread(notesPath).resolved).toBe(true)

    // The referee rejects the answer: the finding is the agents' again, and the thread reopens.
    finding.dispositions[0].verification = { outcome: 'disagrees', reason: 'Still too strong.', family: 'gpt' }
    finding.status = 'open'
    syncEditor(paper)
    expect([finding.status, finding.assignee]).toEqual(['open', 'agents'])
    expect(thread(notesPath).resolved).toBeUndefined()

    // A person resolves it in the editor: it is theirs now.
    const file = JSON.parse(readFileSync(notesPath, 'utf8'))
    file.annotations.find((a: { id: string }) => a.id === 'galley-F1').resolved = true
    writeFileSync(notesPath, JSON.stringify(file))
    const past = new Date(Date.now() - 60_000)
    utimesSync(notesPath, past, past)
    syncEditor(paper)
    expect([finding.status, finding.assignee]).toEqual(['noted', 'humans'])
  })
})
