// Papers for the end-to-end tests that show every paper at once: one being
// written (this test's process stands in for its run), one ready, and one
// whose document is not in the editor.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

export interface Fixture { slug: string, title: string }

export function writePaper(docs: string, papers: string, options: { title: string, running?: boolean, ready?: boolean, document?: boolean, open?: number }): Fixture {
  const slug = `${options.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`
  const dir = join(papers, slug)
  mkdirSync(join(dir, 'out'), { recursive: true })
  const finding = (n: number, status: string) => ({ id: `F1-methods-${n}`, round: 1, seat: 'methods', family: 'gpt', model: 'gpt-6.2-sol', severity: 'minor', sectionId: 'S1', quote: '', question: 'q', alternatives: '', evidence: '', decision: '', status, origin: 'agent', dispositions: [] })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1, slug, createdAt: minutesAgo(60), seed: { text: 'seed', sha256: 'x' },
    brief: { hasSubject: true, concern: 'c', contribution: 'k', objectType: 'finding', field: 'Urban ecology', audience: 'a' },
    claims: [], positioning: {}, directions: [], works: {}, candidates: [], citations: [], figures: [],
    passages: { S1: { sectionId: 'S1', text: 'x', revisions: [] } },
    plan: { thesis: 't', workingTitle: options.title, noun: 'n', opens: [], objectType: 'finding' },
    outline: { sections: [{ id: 'S1', title: 'Introduction', purpose: '', claimIds: [], words: 1, figureIds: [] }, { id: 'S2', title: 'Methods', purpose: '', claimIds: [], words: 1, figureIds: [] }], style: '', glossary: [] },
    findings: [finding(1, 'resolved'), ...Array.from({ length: options.open ?? 0 }, (_, i) => finding(i + 2, 'open'))], round: 1,
    settled: { 'outline:paper': 'done', 'draft:S1': 'done' }, attempts: {}, notes: [],
    ...(options.ready ? { outcome: 'ready_for_submission' } : {}),
  }))
  writeFileSync(join(dir, 'paper.json'), JSON.stringify({ rounds: 2 }))
  writeFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ at: minutesAgo(60), event: 'created' }) + '\n')
  writeFileSync(join(dir, 'progress.json'), JSON.stringify({
    pid: options.running ? process.pid : 999_999_999, outcome: options.ready ? 'ready_for_submission' : null,
    inFlight: options.running ? [{ behavior: 'draft', target: 'S2', what: 'claude-opus-5-5 (author)', started: minutesAgo(2) }] : [],
  }))
  if (options.ready) writeFileSync(join(dir, 'out', 'paper.pdf'), '%PDF-1.4\n')
  if (options.document !== false) writeFileSync(join(docs, `${slug}.md`), `# ${options.title}\n\n## Introduction\n\nx\n`)
  return { slug, title: options.title }
}
