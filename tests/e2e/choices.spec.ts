// "For this claim, choose a, b or c", from the seed document a paper was started from.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

test('a citation choice lists its candidate sources, and picking one records it', async ({ page }) => {
  const dir = process.env.GALLEY_E2E_DIR!
  const slug = `seed-${Date.now()}`
  const paperDir = resolve('papers', `${slug}-paper`)
  writeFileSync(join(dir, `${slug}.md`), 'A seed with something to say.\n')
  mkdirSync(paperDir, { recursive: true })
  const option = (letter: string, workId: string) => ({ letter, claimId: 'C1', workId, passage: `Passage ${letter} says so.`, fit: 'direct', role: 'support', note: '' })
  // Two claims wait, and only one is answered here, so no run starts.
  const state = {
    version: 1, slug: `${slug}-paper`, createdAt: new Date().toISOString(), seed: { text: 'x', sha256: 'x' },
    claims: [{ id: 'C1', text: 'Trees cool streets.', kind: 'background', seedQuote: '', origin: 'seed', need: 'external', loadBearing: true, dependsOn: [], status: 'open', history: [] },
      { id: 'C2', text: 'Young trees cool little.', kind: 'background', seedQuote: '', origin: 'seed', need: 'external', loadBearing: true, dependsOn: [], status: 'open', history: [] }],
    positioning: {}, directions: [], works: { W1: { id: 'W1', doi: null, title: 'Street trees and heat', authors: ['A. Author'], year: 2020, venue: null, abstract: '', citedBy: null, url: null }, W2: { id: 'W2', doi: null, title: 'Canopy and cooling', authors: ['B. Author'], year: 2021, venue: null, abstract: '', citedBy: null, url: null } },
    candidates: [], citations: [], passages: {}, figures: [], findings: [], round: 0, settled: {}, attempts: {}, notes: [],
    choices: { C1: { claimId: 'C1', options: [option('a', 'W1'), option('b', 'W2')], asked: new Date().toISOString() }, C2: { claimId: 'C2', options: [option('a', 'W1')], asked: new Date().toISOString() } },
  }
  writeFileSync(join(paperDir, 'state.json'), JSON.stringify(state))
  writeFileSync(join(paperDir, 'paper.json'), JSON.stringify({ citations: 'mixed' }))
  try {
    await page.goto('/')
    await page.waitForFunction(() => !!window.galley?.slug)
    await page.evaluate((s) => window.galley.open(s), slug)
    await page.waitForFunction((s) => window.galley.slug === s, slug)
    await page.locator('[data-action="citation-choices"]').click()
    await expect(page.locator('.demo-proposals-head')).toContainText('2 claims waiting')
    const first = page.locator('.demo-proposal').first()
    await expect(first).toContainText('Canopy and cooling')
    await first.getByRole('button', { name: 'b)' }).click()
    await expect(page.locator('.demo-proposals-head')).toContainText('1 claim waiting')
    const saved = JSON.parse(readFileSync(join(paperDir, 'state.json'), 'utf8'))
    expect(saved.choices.C1.answered.letters).toEqual(['b'])
    expect(saved.citations).toEqual([expect.objectContaining({ claimId: 'C1', workId: 'W2', status: 'selected', chosenBy: 'human' })])
  } finally {
    rmSync(paperDir, { recursive: true, force: true })
  }
})
