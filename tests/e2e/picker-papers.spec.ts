// Every paper in the document picker, as a writer uses it: under each paper's
// name where it stands and who is at work on what, the papers whose document
// is not here at its foot, and picking a paper opens it as it always did.
import { expect, test } from '@playwright/test'
import { writePaper } from './support/papers.js'

const docs = () => process.env.GALLEY_E2E_DIR!
const papers = () => process.env.GALLEY_E2E_PAPERS!
const slugNow = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { galley: { slug: string | null } }).galley.slug)

test('the picker says how every paper is doing, and picking one opens it', async ({ page }) => {
  const writing = writePaper(docs(), papers(), { title: 'Street Trees in Review', running: true, open: 2 })
  const ready = writePaper(docs(), papers(), { title: 'Pit Size Ready', ready: true, document: false })

  await page.goto('/')
  await expect.poll(() => slugNow(page)).not.toBeNull()
  await page.locator('.galley-picker-trigger').click()
  const item = page.locator('.galley-picker-item', { hasText: writing.title })
  await expect(item.locator('.pp-state')).toHaveText('Writing · Draft')
  await expect(item.locator('.pp-words')).toHaveText('Round 1 of 2 · 2 of 3 findings open · 1/2 sections')
  await expect(item.locator('.pp-ago')).toHaveText(/^changed \d+ s ago$/)
  await expect(item.locator('.pp-work')).toHaveText(/Author drafting Methods\s*2 min/)
  // A paper whose document is not here is at the foot, and opens as its PDF.
  const away = page.locator('.pp-away', { hasText: ready.title })
  await expect(away).toHaveAttribute('href', `/papers/${ready.slug}/paper.pdf`)
  await expect(away.locator('.pp-state')).toHaveText('Ready for submission')

  await item.click()
  await expect.poll(() => slugNow(page)).toBe(writing.slug)
})
