// Deleting from the document picker: every row has a button that deletes its
// document, asked first in the editor's own dialog; a document's project goes
// with it, and a run still going for it is stopped first.
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { writePaper } from './support/papers.js'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

const docs = () => process.env.GALLEY_E2E_DIR!
const papers = () => process.env.GALLEY_E2E_PAPERS!

async function newDocument(page: Page, title: string): Promise<string> {
  const before = await page.evaluate(() => window.galley.slug)
  await page.locator('[data-action="new"]').click()
  await page.waitForFunction((prev) => !!window.galley.slug && window.galley.slug !== prev, before)
  await page.keyboard.type(`# ${title}`)
  const slug = (await page.evaluate(() => window.galley.slug))!
  await expect.poll(async () => (await (await page.request.get(`/api/galley/doc/${slug}`)).json()).content).toBe(`# ${title}`)
  return slug
}

const deleteButton = (page: Page, slug: string) => page.locator(`.galley-picker-row:has([data-slug="${slug}"]) .galley-picker-delete`)

test('every document in the picker has a delete button: a dialog asks, Cancel keeps it, Delete removes it and the menu stays open', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  const alpha = await newDocument(page, 'Alpha')
  const beta = await newDocument(page, 'Beta')
  await page.locator('.galley-picker-trigger').click()
  await deleteButton(page, alpha).click()
  const dialog = page.locator('dialog.galley-dialog')
  await expect(dialog.locator('.galley-dialog-title')).toHaveText('Delete “Alpha”?')
  await expect(dialog).toContainText('The document and its notes are deleted.')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect((await page.request.get(`/api/galley/doc/${alpha}`)).status()).toBe(200)
  await deleteButton(page, alpha).click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect.poll(async () => (await page.request.get(`/api/galley/doc/${alpha}`)).status()).toBe(404)
  await expect(page.locator(`.galley-picker-item[data-slug="${alpha}"]`)).toHaveCount(0)
  await expect(page.locator('.galley-picker-menu')).toBeVisible()
  expect(await page.evaluate(() => window.galley.slug)).toBe(beta)
})

// Asking takes a moment (what goes with the document is looked up first): long enough to open another document.
const slowAsking = (page: Page) => page.route('**/api/galley-live', async (route) => {
  await new Promise((done) => setTimeout(done, 1500))
  await route.continue().catch(() => { /* the page moved on */ })
})
const open = async (page: Page, slug: string) => {
  await page.evaluate((s) => window.galley.open(s), slug)
  await page.waitForFunction((s) => window.galley.slug === s, slug)
}

test('opening another document while a delete is asked leaves the page on it', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  const first = await newDocument(page, 'First')
  const second = await newDocument(page, 'Second')
  await newDocument(page, 'Third')
  await open(page, first)
  await slowAsking(page)
  await page.locator('[data-action="delete"]').click()
  await open(page, second)
  const dialog = page.locator('dialog.galley-dialog')
  await expect(dialog.locator('.galley-dialog-title')).toHaveText('Delete “First”?')
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect.poll(async () => (await page.request.get(`/api/galley/doc/${first}`)).status()).toBe(404)
  expect(await page.evaluate(() => window.galley.slug)).toBe(second)
  expect(await page.evaluate(() => window.galley.text())).toBe('# Second')
})

test('a document opened while its delete is asked is deleted as the open one, and the page moves on from it', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  const target = await newDocument(page, 'Target')
  await newDocument(page, 'Stays')
  await slowAsking(page)
  await page.locator('.galley-picker-trigger').click()
  await deleteButton(page, target).click()
  await open(page, target)
  await page.locator('dialog.galley-dialog').getByRole('button', { name: 'Delete' }).click()
  await expect.poll(async () => (await page.request.get(`/api/galley/doc/${target}`)).status()).toBe(404)
  await page.waitForFunction((s) => !!window.galley.slug && window.galley.slug !== s, target)
})

test('when what goes with a document cannot be checked, the dialog says so instead of promising only the document goes', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  await newDocument(page, 'Unchecked')
  await page.route('**/api/galley-live', (route) => route.fulfill({ status: 500, body: '' }))
  await page.locator('[data-action="delete"]').click()
  const dialog = page.locator('dialog.galley-dialog')
  await expect(dialog).toContainText('with anything kept with it; what that includes could not be checked.')
  await expect(dialog).not.toContainText('The document and its notes are deleted.This')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
})

test('deleting a document deletes the project made from it, and stops a run still going for it first', async ({ page }) => {
  const paper = writePaper(docs(), papers(), { title: 'Delete me' })
  const dir = join(papers(), paper.slug)
  // A stand-in for its run: a process that names the paper's folder, in a process group of its own, as galley starts runs.
  const run = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', dir], { detached: true, stdio: 'ignore' })
  writeFileSync(join(dir, 'progress.json'), JSON.stringify({ pid: run.pid, outcome: null, inFlight: [] }))
  const exited = new Promise((done) => run.once('exit', done))
  try {
    await page.goto('/')
    await page.waitForFunction(() => !!window.galley?.slug)
    await newDocument(page, 'Kept')
    await page.locator('.galley-picker-trigger').click()
    await deleteButton(page, paper.slug).click()
    const dialog = page.locator('dialog.galley-dialog')
    await expect(dialog).toContainText('the project made from it are deleted')
    await expect(dialog).toContainText('Its run is still going and is stopped first.')
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect.poll(async () => (await page.request.get(`/api/galley/doc/${paper.slug}`)).status()).toBe(404)
    await exited
    expect(existsSync(dir)).toBe(false)
  } finally {
    if (run.exitCode === null && run.signalCode === null) run.kill('SIGKILL')
  }
})
