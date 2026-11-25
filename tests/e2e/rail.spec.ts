// Every paper beside the page, as a writer uses it: where each stands and who
// is at work on what, whichever document is open; the open paper marked; any
// other one click away; and the rail folded to rings when the text wants room.
import { expect, test } from '@playwright/test'
import { writePaper } from './support/papers.js'

const docs = () => process.env.GALLEY_E2E_DIR!
const papers = () => process.env.GALLEY_E2E_PAPERS!
const slugNow = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { galley: { slug: string | null } }).galley.slug)

test('every paper is beside the page, the open one marked and any other one click away', async ({ page }) => {
  const writing = writePaper(docs(), papers(), { title: 'Street Trees in Review', running: true, open: 2 })
  const ready = writePaper(docs(), papers(), { title: 'Pit Size Ready', ready: true, document: false })

  await page.goto('/')
  const entry = page.locator('.pr-item', { hasText: writing.title })
  await expect(entry.locator('.pr-where')).toHaveText('Draft · Round 1 of 2')
  await expect(entry.locator('.pr-far')).toHaveText('1/2 sections · 2 of 3 findings open')
  await expect(entry.locator('.pr-ago')).toHaveText(/^\d+ s$/)
  await expect(entry.locator('.pr-work')).toHaveText(/Author drafting Methods\s*2 min/)
  // A paper whose document is not here opens as its PDF.
  const away = page.locator('.pr-item', { hasText: ready.title })
  await expect(away.locator('.pr-where')).toHaveText('Ready for submission')
  await expect(away.locator('.pr-entry')).toHaveAttribute('href', `/papers/${ready.slug}/paper.pdf`)

  await entry.locator('.pr-entry').click()
  await expect.poll(() => slugNow(page)).toBe(writing.slug)
  await expect(page).toHaveURL(new RegExp(`\\?doc=${writing.slug}`))
  await expect(entry).toHaveClass(/is-current/)

  // Folded, it is a ring a paper, and it stays folded.
  await page.getByRole('button', { name: 'Fold the papers' }).click()
  await expect(entry.locator('.pr-ring')).toHaveText('ST')
  await expect(entry.locator('.pr-ring')).toBeVisible()
  await page.reload()
  await expect(page.locator('.pr')).toHaveClass(/is-folded/)
})

test('the window never scrolls sideways, not even while the Activity pane slides in beside the rail', async ({ page }) => {
  const writing = writePaper(docs(), papers(), { title: 'Street Trees Sideways', running: true })
  await page.addInitScript(() => {
    const w = window as unknown as { sideways: number }
    w.sideways = 0
    const sample = () => {
      w.sideways = Math.max(w.sideways, document.documentElement.scrollWidth - document.documentElement.clientWidth)
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.goto(`/?doc=${writing.slug}&view=activity`)
  await expect(page.locator('.pr-item', { hasText: writing.title })).toHaveClass(/is-current/)
  // The pane has slid all the way in.
  await page.waitForFunction(() => {
    const side = document.querySelector('.galley-slot[data-slot="side"]')
    return !!side?.classList.contains('lv-opening') && side.getAnimations().length === 0
  })
  expect(await page.evaluate(() => (window as unknown as { sideways: number }).sideways)).toBe(0)
})
