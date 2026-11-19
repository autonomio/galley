// A paper being written in the editor, as a writer sees it: who is working on
// it right now, its threads, its history, and the agents' changes arriving in
// the open document while the writer works in it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

const docs = () => process.env.GALLEY_E2E_DIR!
const papers = () => process.env.GALLEY_E2E_PAPERS!
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

/** A paper in its first review round: one section drafted, one finding answered, the Author at work on the introduction. */
function paperFixture(): string {
  const slug = `trees-${Date.now()}-paper`
  const dir = join(papers(), slug)
  mkdirSync(dir, { recursive: true })
  const finding = {
    id: 'F1-methods-1', at: minutesAgo(20), round: 1, seat: 'methods', family: 'gpt', model: 'gpt-6.2-sol', severity: 'material', sectionId: 'S1',
    quote: 'Wider pits help', question: 'Which study shows this?', alternatives: '', evidence: '', decision: '', edit: null, status: 'open', assignee: 'agents', origin: 'agent',
    dispositions: [{ at: minutesAgo(10), kind: 'fixed', text: 'Fixed. Now cites the survival study.', edits: [], family: 'claude' }],
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1, slug, createdAt: minutesAgo(60), seed: { text: 'Street trees die young.', sha256: 'x' },
    brief: { hasSubject: true, concern: 'c', contribution: 'k', objectType: 'finding', field: 'Urban ecology', audience: 'a' },
    claims: [], positioning: {}, directions: [], works: {}, candidates: [], citations: [], figures: [], passages: { S1: { sectionId: 'S1', text: 'Wider pits help street trees live longer.', revisions: [], checked: 'faithful' } },
    plan: { thesis: 't', workingTitle: 'Pit Size and Street-Tree Survival', noun: 'n', opens: [], objectType: 'finding' },
    outline: { sections: [{ id: 'S1', title: 'Introduction', purpose: '', claimIds: [], words: 1, figureIds: [] }, { id: 'S2', title: 'Methods', purpose: '', claimIds: [], words: 1, figureIds: [] }], style: '', glossary: [] },
    findings: [finding], round: 1, settled: { 'outline:paper': 'done', 'draft:S1': 'done' }, attempts: {}, notes: [],
  }))
  writeFileSync(join(dir, 'paper.json'), '{}')
  writeFileSync(join(dir, 'journal.jsonl'), [
    { at: minutesAgo(60), event: 'created' },
    { at: minutesAgo(40), event: 'call', behavior: 'draft', seat: 'author', family: 'claude', model: 'claude-opus-5-5' },
    { at: minutesAgo(39), event: 'settled', behavior: 'draft', target: 'draft:S1', how: 'done' },
    { at: minutesAgo(20), event: 'review', round: 1, seat: 'methods', family: 'gpt', verdict: 'major_revision', summary: 's' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')
  // The run in progress: this test's own process stands in for it.
  writeFileSync(join(dir, 'progress.json'), JSON.stringify({ pid: process.pid, outcome: null, inFlight: [{ behavior: 'draft', target: 'S2', what: 'claude-opus-5-5 (author)', started: minutesAgo(1) }] }))
  writeFileSync(join(docs(), `${slug}.md`), '# Pit Size and Street-Tree Survival\n\n## Introduction\n\nWider pits help street trees live longer.\n\n## Methods\n')
  writeFileSync(join(docs(), `${slug}.annotations.json`), JSON.stringify({ annotations: [{
    id: 'galley-F1-methods-1', range: { start_line: 4, start_offset: 0, end_line: 4, end_offset: 15 }, snippet: 'Wider pits help', comment: 'Which study shows this?',
    created_at: minutesAgo(20), updated_at: minutesAgo(10), author: { name: 'Methods referee', kind: 'agent', detail: 'GPT-6.2 Sol', tone: 'b' },
    replies: [{ id: 'galley-F1-methods-1-d0', author: { name: 'Author', kind: 'agent', detail: 'Claude Opus 5.5', tone: 'a' }, text: '**Fixed.** Now cites the survival study.', created_at: minutesAgo(10) }],
    labels: [{ text: 'material' }, { text: 'answered' }],
  }] }))
  return slug
}

async function openPaper(page: Page, slug: string): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  await page.evaluate((s) => window.galley.open(s), slug)
  await page.waitForFunction((s) => window.galley.slug === s, slug)
}

test('the team at work shows above the paper, beside the passage each is writing, and in its history', async ({ page }) => {
  const slug = paperFixture()
  await openPaper(page, slug)
  const team = page.locator('.lv-team')
  await expect(team.locator('.lv-seat.is-busy')).toContainText('drafting Methods')
  await expect(team.locator('.lv-state')).toContainText('Writing')
  await expect(page.locator('.lv-notes')).toContainText('Seed read')
  await expect(page.locator('.lv-mark .lv-face')).toHaveCount(1)

  await page.locator('[data-history]').first().click()
  const history = page.locator('#history')
  await expect(history).toBeVisible()
  await expect(history.locator('.lv-now')).toContainText('drafting Methods')
  await expect(history.locator('.lv-entry')).toContainText(['You started the paper from your seed.', 'Author drafted Introduction.', 'Methods referee reviewed the manuscript: major revision.'])
})

test('a finding is a thread: every answer shows, and a reply is saved beside the paper', async ({ page }) => {
  const slug = paperFixture()
  await openPaper(page, slug)
  await page.locator('.galley-mark').first().click()
  const thread = page.locator('.galley-note.is-thread')
  await expect(thread.locator('.galley-thread-item')).toHaveCount(2)
  await expect(thread).toContainText('Which study shows this?')
  await expect(thread).toContainText('Now cites the survival study.')
  await thread.locator('.galley-note-text').fill('Cite the street-tree survey as well.')
  await thread.getByRole('button', { name: 'Reply' }).click()
  await expect(thread.locator('.galley-thread-item')).toHaveCount(3)
  await expect.poll(async () => {
    const res = await page.request.get(`/api/galley/doc/${slug}/annotations`)
    return (await res.json()).annotations[0].replies.at(-1)?.text
  }).toBe('Cite the street-tree survey as well.')
  await thread.getByRole('button', { name: 'Resolve' }).click()
  await expect(thread).toHaveClass(/is-resolved/)
})

test('an agent\'s change arrives in the open document and merges with what the writer is typing', async ({ page }) => {
  const slug = paperFixture()
  await openPaper(page, slug)
  // The engine writes the next draft into the document while the writer has it open.
  const engine = '# Pit Size and Street-Tree Survival\n\n## Introduction\n\nWider pits help street trees live longer.\n\n## Methods\n\nWe measured 412 pits across three cities.\n'
  writeFileSync(join(docs(), `${slug}.md`), engine)
  await expect(page.locator('.galley-doc')).toContainText('We measured 412 pits')
  // The writer edits the introduction; the Author changes the methods at the same time.
  await page.evaluate(() => {
    const line = [...document.querySelectorAll('.galley-line')].find((l) => l.textContent?.startsWith('Wider pits'))!
    const range = document.createRange()
    range.selectNodeContents(line)
    range.collapse(false)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  await page.keyboard.type(' In our data, by years.')
  writeFileSync(join(docs(), `${slug}.md`), engine.replace('three cities', 'four cities'))
  await expect.poll(() => readFileSync(join(docs(), `${slug}.md`), 'utf8'), { timeout: 10_000 }).toContain('live longer. In our data, by years.')
  await expect.poll(() => readFileSync(join(docs(), `${slug}.md`), 'utf8'), { timeout: 10_000 }).toContain('four cities')
  await expect(page.locator('.galley-notice')).toHaveCount(0)
})
