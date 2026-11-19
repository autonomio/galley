// One document, one project: play on a seed starts the project in the same
// document. The seed's words give way to the living paper there, and they stay
// in the project, folded away in its settings.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

test('starting a paper turns its seed document into the paper, and keeps the seed in the project', async ({ page }) => {
  test.setTimeout(60_000)
  const docs = process.env.GALLEY_E2E_DIR!
  const slug = `seed-${Date.now()}`
  const blurb = `Street trees in narrow pavement pits die young because their roots have too little soil. ${'Cities replace them at great cost every few years, and planners need a rule for pit size. '.repeat(4)}`
  writeFileSync(join(docs, `${slug}.md`), `${blurb}\n`)
  await page.goto(`/?doc=${slug}`)
  await page.waitForFunction((s) => window.galley?.slug === s, slug)

  await page.locator('[data-action="write-paper"]').click()
  const wizard = page.locator('dialog.gw')
  for (const step of ['Next: Materials', 'Next: Settings', 'Next: Start']) await wizard.getByRole('button', { name: step }).click()
  await wizard.getByRole('button', { name: 'Start the paper' }).click()
  await expect(wizard.getByRole('heading', { name: 'Writing the paper' })).toBeVisible()
  await expect(wizard).toContainText('This document is now the paper')

  // The paper is written into this document; no second document appears.
  await expect.poll(() => readFileSync(join(docs, `${slug}.md`), 'utf8'), { timeout: 30_000 }).toBe('# Untitled paper\n')
  expect(existsSync(join(docs, `${slug}-paper.md`))).toBe(false)
  const project = join(process.env.GALLEY_E2E_PAPERS!, slug)
  expect(readFileSync(join(project, 'seed.md'), 'utf8')).toContain('Street trees in narrow pavement pits')
  expect(JSON.parse(readFileSync(join(project, 'paper.json'), 'utf8')).editorDoc).toBe(slug)

  // The open editor shows the paper, and play now opens the project's settings with the seed.
  await wizard.getByRole('button', { name: /Open the paper|Close/ }).click()
  await expect.poll(() => page.evaluate(() => window.galley.text()), { timeout: 15_000 }).toContain('Untitled paper')
  await page.locator('[data-action="write-paper"]').click()
  const status = page.locator('dialog.gw--status')
  await status.locator('details.gw-seed summary').click()
  await expect(status.locator('details.gw-seed')).toContainText('Street trees in narrow pavement pits')
})
