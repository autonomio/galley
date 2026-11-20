// Every paper on a page of its own, as a writer uses it: where each stands,
// who is at work on it, how far it has come, and the way into it.
import { expect, test } from '@playwright/test'
import { writePaper } from './support/papers.js'

const docs = () => process.env.GALLEY_E2E_DIR!
const papers = () => process.env.GALLEY_E2E_PAPERS!

test('the papers page shows every paper and opens one where its work is', async ({ page }) => {
  const writing = writePaper(docs(), papers(), { title: 'Street Trees in Review', running: true, open: 2 })
  const ready = writePaper(docs(), papers(), { title: 'Pit Size Ready', ready: true, document: false })

  // From the editor's row to the page, which has a link of its own.
  await page.goto('/')
  await page.getByRole('button', { name: 'All papers' }).click()
  await expect(page).toHaveURL(/\/papers\/$/)

  const card = page.locator('.ov-card', { hasText: writing.title })
  await expect(card.locator('.ov-state')).toHaveText('Writing · Draft')
  await expect(card.locator('.ov-ago')).toHaveText(/^changed \d+ s ago$/)
  await expect(card.locator('.ov-now-row')).toHaveText(/Author drafting Methods\s*2 min/)
  await expect(card.locator('[data-stat="sections"] dd')).toHaveText('1/2')
  await expect(card.locator('[data-stat="round"] dd')).toHaveText('1 of 2')
  await expect(card.locator('[data-stat="open"] dd')).toHaveText('2 of 3')
  // A paper whose document is not here opens as its PDF.
  const done = page.locator('.ov-card', { hasText: ready.title })
  await expect(done.locator('.ov-state')).toHaveText('Ready for submission')
  await expect(done.locator('.ov-hit')).toHaveAttribute('href', `/papers/${ready.slug}/paper.pdf`)

  await card.locator('.ov-hit').click()
  await expect(page).toHaveURL(new RegExp(`\\?doc=${writing.slug}&view=activity$`))
  await expect(page.locator('.lv-now-list')).toContainText('drafting Methods')
})
