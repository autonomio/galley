// Comments beside the text: every note a card in a column of its own right of
// the text, level with its passage, and one switch that hides them all and
// shows them again, kept in the link.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

test('every note is a card beside its passage, and one switch hides them all, kept in the link', async ({ page }) => {
  const slug = `margin-${Date.now()}`
  const at = new Date().toISOString()
  const note = (id: string, line: number, snippet: string, extra: object) => ({
    id, range: { start_line: line, start_offset: 0, end_line: line, end_offset: snippet.length }, snippet, comment: `About ${snippet}.`, created_at: at, updated_at: at, ...extra,
  })
  writeFileSync(join(process.env.GALLEY_E2E_DIR!, `${slug}.md`), '# Pits\n\nWider pits help street trees live longer.\n\nThe effect is largest in the first five years.\n')
  writeFileSync(join(process.env.GALLEY_E2E_DIR!, `${slug}.annotations.json`), JSON.stringify({ annotations: [
    note('wider', 2, 'Wider pits help', { author: { name: 'Verifier', kind: 'agent', tone: 'c' }, labels: [{ text: 'unverified', tone: 'attention' }] }),
    note('effect', 4, 'The effect', { resolved: true }),
  ] }))
  await page.goto(`/?doc=${slug}`)
  const cards = page.locator('.galley-card')
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText('Verifier')
  await expect(cards.first()).toContainText('unverified')
  // In a column right of the text, the first level with the first line of its passage.
  const text = (await page.locator('.galley-doc').boundingBox())!
  const card = (await cards.first().boundingBox())!
  const mark = (await page.locator('.galley-mark[data-annotation="wider"]').boundingBox())!
  expect(card.x).toBeGreaterThan(text.x + text.width)
  expect(Math.abs(card.y - mark.y)).toBeLessThan(2)
  // A card opens its thread, and its passage stays lit while it is open.
  await cards.first().click()
  await expect(page.locator('.galley-note')).toContainText('About Wider pits help.')
  await expect(page.locator('.galley-mark.is-open')).toHaveCount(1)

  const hide = page.getByRole('button', { name: 'Hide comments' })
  await hide.click()
  await expect(cards).toHaveCount(0)
  await expect(page.locator('.galley-marks')).toBeHidden()
  await expect(page.locator('.galley-note')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`\\?doc=${slug}&comments=off$`))
  // The link opens with them hidden.
  await page.reload()
  // Drawn, but out of sight.
  await expect(page.locator('.galley-mark')).toHaveCount(2)
  await expect(cards).toHaveCount(0)
  await expect(page.locator('.galley-marks')).toBeHidden()
  await hide.click()
  await expect(cards).toHaveCount(2)
  await expect(page.locator('.galley-marks')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`\\?doc=${slug}$`))
})
