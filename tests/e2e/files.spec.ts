// A project's files: the icon on the left opens what its paper has made, each
// file has a link of its own, and the list is a link as well.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

const docs = () => process.env.GALLEY_E2E_DIR!
const papers = () => process.env.GALLEY_E2E_PAPERS!

/** A typeset paper: its document, and what its out/ folder holds beside a file that is not its own to share. */
function typesetPaper(): string {
  const slug = `files-${Date.now()}`
  const dir = join(papers(), slug)
  mkdirSync(join(dir, 'out', 'figures'), { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1, slug, createdAt: new Date().toISOString(), seed: { text: 'A seed.', sha256: 'x' },
    brief: { hasSubject: true, concern: 'c', contribution: 'k', objectType: 'finding', field: 'f', audience: 'a' },
    claims: [], positioning: {}, directions: [], works: {}, candidates: [], citations: [], figures: [], passages: {},
    plan: { thesis: 't', workingTitle: 'A Typeset Paper', noun: 'n', opens: [], objectType: 'finding' },
    outline: { sections: [], style: '', glossary: [] },
    findings: [], round: 0, settled: {}, attempts: {}, notes: [],
  }))
  writeFileSync(join(dir, 'paper.json'), '{}')
  writeFileSync(join(dir, 'journal.jsonl'), '')
  writeFileSync(join(dir, 'materials.csv'), 'private,data\n')
  writeFileSync(join(dir, 'out', 'paper.pdf'), '%PDF-1.4\n% a stand-in\n')
  writeFileSync(join(dir, 'out', 'refs.bib'), '@article{a, title={A}}\n')
  writeFileSync(join(dir, 'out', 'signoff.md'), '# Sign-off\n')
  writeFileSync(join(dir, 'out', 'figures', 'fig1.png'), 'png')
  writeFileSync(join(dir, 'out', '.draft'), 'not for anyone')
  // Links in out/ to what is not out/'s to share.
  symlinkSync(join(dir, 'materials.csv'), join(dir, 'out', 'materials.csv'))
  symlinkSync(join(dir, 'materials.csv'), join(dir, 'out', 'figures', 'notes.csv'))
  writeFileSync(join(docs(), `${slug}.md`), '# A Typeset Paper\n\nIts files are ready.\n')
  return slug
}

test('the files icon on the left opens what the paper has made, each file a link of its own', async ({ page, request }) => {
  const slug = typesetPaper()
  await page.goto(`/?doc=${slug}`)
  await page.waitForFunction((s) => window.galley?.slug === s, slug)
  const icon = page.locator('[data-action="files"]')
  expect((await icon.boundingBox())!.x).toBeLessThan((await page.locator('.galley-picker-trigger').boundingBox())!.x)

  await icon.click()
  const dialog = page.locator('dialog.gw--files')
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`\\?doc=${slug}&view=files$`))
  // The PDF first; a folder is one row; what is hidden is left out.
  await expect(dialog.locator('.df-row .df-name')).toHaveText(['Paper', 'References', 'Figures', 'Sign-off sheet'])
  await expect(dialog.getByRole('link', { name: 'Paper', exact: true })).toHaveAttribute('href', `/papers/${slug}/paper.pdf`)
  // The controls in the dialog are the editor's own, tips and all.
  await dialog.getByRole('button', { name: 'Download everything' }).hover()
  await expect(dialog.locator('.galley-tooltip.is-shown')).toContainText('Every file the paper has made')
  await dialog.getByRole('button', { name: 'Show the files in Figures' }).click()
  await expect(dialog.getByRole('link', { name: 'fig1.png' })).toHaveAttribute('href', `/papers/${slug}/figures/fig1.png`)

  const pdf = await request.get(`/papers/${slug}/paper.pdf`)
  expect(pdf.status()).toBe(200)
  expect(pdf.headers()['content-type']).toBe('application/pdf')
  expect((await request.get(`/papers/${slug}/refs.bib`)).headers()['content-type']).toBe('text/plain; charset=utf-8')
  // A folder comes as one zip, and so does everything: what the list shows,
  // never what a link in out/ points to elsewhere, nor what is hidden.
  const folder = await request.get(`/papers/${slug}/figures.zip`)
  expect(folder.headers()['content-type']).toBe('application/zip')
  const inFolder = (await folder.body()).toString('latin1')
  expect(inFolder).toContain('figures/fig1.png')
  expect(inFolder).not.toContain('notes.csv')
  const all = await request.get(`/papers/${slug}.zip`)
  expect(all.headers()['content-type']).toBe('application/zip')
  const inAll = (await all.body()).toString('latin1')
  for (const name of ['paper.pdf', 'refs.bib', 'signoff.md', 'figures/fig1.png']) expect(inAll).toContain(name)
  for (const name of ['materials.csv', 'notes.csv', 'private,data', '.draft']) expect(inAll).not.toContain(name)
  // Nothing hidden, and nothing from outside out/.
  expect((await request.get(`/papers/${slug}/materials.csv`)).status()).toBe(404)
  expect((await request.get(`/papers/${slug}/.draft`)).status()).toBe(404)
  expect((await request.get(`/papers/${slug}/..%2Fmaterials.csv`)).status()).toBe(404)
  expect((await request.get(`/papers/${slug}/figures%2F..%2F..%2Fstate.json`)).status()).toBe(404)

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`\\?doc=${slug}$`))
})

test('a file\'s link can be copied, to pass on', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const slug = typesetPaper()
  await page.goto(`/?doc=${slug}&view=files`)
  const row = page.locator('.df-row', { has: page.getByRole('link', { name: 'Paper', exact: true }) })
  await row.getByRole('button', { name: 'Copy link' }).click()
  await expect(row.locator('.galley-bar-btn.is-done')).toHaveCount(1)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(`/papers/${slug}/paper.pdf`, page.url()).href)
})

test('the list is a link too: /papers/<doc>/ opens the document with its files', async ({ page }) => {
  const slug = typesetPaper()
  await page.goto(`/papers/${slug}/`)
  await expect(page).toHaveURL(new RegExp(`\\?doc=${slug}&view=files$`))
  await expect(page.locator('dialog.gw--files .gw-title')).toHaveText('A Typeset Paper')
})

test('a document with no paper says so', async ({ page }) => {
  const slug = `plain-${Date.now()}`
  writeFileSync(join(docs(), `${slug}.md`), '# Notes\n\nNo paper here.\n')
  await page.goto(`/?doc=${slug}&view=files`)
  await expect(page.locator('dialog.gw--files')).toContainText('This document has no paper yet.')
  await expect(page.locator('dialog.gw--files').getByRole('button', { name: 'Download everything' })).toBeDisabled()
})
