// Everything on screen is a link: the address bar names the open document and
// what is open with it, Back and Forward walk the documents, and opening the
// link opens the same screen.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

const docs = () => process.env.GALLEY_E2E_DIR!

function two(): [string, string] {
  const at = Date.now()
  writeFileSync(join(docs(), `walk-a-${at}.md`), '# A\n\nThe first.\n')
  writeFileSync(join(docs(), `walk-b-${at}.md`), '# B\n\nThe second.\n')
  return [`walk-a-${at}`, `walk-b-${at}`]
}

test('the bare address names the document it opens', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  const slug = await page.evaluate(() => window.galley.slug)
  await expect(page).toHaveURL(new RegExp(`\\?doc=${slug}$`))
})

test('another document is a step: Back and Forward walk them', async ({ page }) => {
  const [a, b] = two()
  await page.goto(`/?doc=${a}`)
  await page.waitForFunction((s) => window.galley?.slug === s, a)
  await page.evaluate((s) => window.galley.open(s), b)
  await expect(page).toHaveURL(new RegExp(`\\?doc=${b}$`))
  await page.goBack()
  await page.waitForFunction((s) => window.galley.slug === s, a)
  await expect(page.locator('body')).toContainText('The first.')
  await expect(page).toHaveURL(new RegExp(`\\?doc=${a}$`))
  await page.goForward()
  await page.waitForFunction((s) => window.galley.slug === s, b)
  await expect(page.locator('body')).toContainText('The second.')
})

test('writer mode is in the link, and the link opens it', async ({ page }) => {
  const [a] = two()
  await page.goto(`/?doc=${a}&view=writer&theme=light`)
  await page.waitForFunction((s) => window.galley?.slug === s, a)
  await expect(page.locator('.galley--writer')).toHaveCount(1)
  await page.evaluate(() => window.galley.setWriterMode(false))
  // Off again, and the host's own setting kept.
  await expect(page).toHaveURL(new RegExp(`\\?doc=${a}&theme=light$`))
})

test('a link to a document that is not here says so, and names the one it opened', async ({ page }) => {
  await page.goto(`/?doc=gone-${Date.now()}`)
  await page.waitForFunction(() => !!window.galley?.slug)
  await expect(page.locator('body')).toContainText('There is no document')
  const slug = await page.evaluate(() => window.galley.slug)
  await expect(page).toHaveURL(new RegExp(`\\?doc=${slug}$`))
})
