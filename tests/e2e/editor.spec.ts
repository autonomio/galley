// The editor as a writer uses it: typing, gestures, notes, saving, conflicts.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

const MOD = 'ControlOrMeta'

async function newDocument(page: Page, path = '/'): Promise<string> {
  await page.goto(path)
  await page.waitForFunction(() => !!window.galley?.slug)
  const before = await page.evaluate(() => window.galley.slug)
  await page.locator('[data-action="new"]').click()
  await page.waitForFunction((prev) => !!window.galley.slug && window.galley.slug !== prev, before)
  await expect(page.locator('.galley-doc')).toBeFocused()
  return (await page.evaluate(() => window.galley.slug))!
}

/** The document as the server has it. */
async function saved(page: Page, slug: string): Promise<string> {
  const res = await page.request.get(`/api/galley/doc/${slug}`)
  return (await res.json()).content
}

async function savedNotes(page: Page, slug: string): Promise<{ snippet: string, comment: string }[]> {
  const res = await page.request.get(`/api/galley/doc/${slug}/annotations`)
  return (await res.json()).annotations
}

test('markdown is drawn as typed and saved exactly as typed', async ({ page }) => {
  const slug = await newDocument(page)
  await page.keyboard.type('# Plan')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Some **bold** and `code`.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')

  await expect(page.locator('.galley-line[data-kind="h1"]')).toHaveText('# Plan')
  await expect(page.locator('.galley-line strong')).toHaveText('**bold**')
  await expect(page.locator('.galley-line[data-kind="list-item"]')).toHaveCount(2)
  await expect.poll(() => saved(page, slug)).toBe('# Plan\nSome **bold** and `code`.\n- one\n- two')
  await expect(page.locator('.galley-picker-title')).toHaveText('Plan')
  await expect(page.locator('.galley-status-words')).toHaveText('7 words')
})

test('⌘B bolds a selection and undo takes it back', async ({ page }) => {
  const slug = await newDocument(page)
  await page.keyboard.type('plain word')
  await page.keyboard.down('Shift')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.up('Shift')
  await page.keyboard.press(`${MOD}+b`)
  await expect.poll(() => page.evaluate(() => window.galley.text())).toBe('plain **word**')
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => page.evaluate(() => window.galley.text())).toBe('plain word')
  await page.keyboard.press(`${MOD}+Shift+z`)
  await expect.poll(() => saved(page, slug)).toBe('plain **word**')
})

test('cut across lines takes exactly what it copies, as one undo step', async ({ page }) => {
  await newDocument(page)
  await page.keyboard.type('# Title')
  await page.keyboard.press('Enter')
  await page.keyboard.type('first **bold** line')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second **kept** end')
  await page.waitForTimeout(600) // let the typing step close
  await page.evaluate(() => {
    const lines = document.querySelectorAll('.galley-line')
    const range = document.createRange()
    range.setStart(lines[1], 0)
    range.setEnd(lines[2], 0)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  await page.keyboard.press(`${MOD}+x`)
  await expect.poll(() => page.evaluate(() => window.galley.text())).toBe('# Title\nsecond **kept** end')
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => page.evaluate(() => window.galley.text())).toBe('# Title\nfirst **bold** line\nsecond **kept** end')
})

test('Enter after a pipe row makes a table, and Tab walks its cells', async ({ page }) => {
  const slug = await newDocument(page)
  await page.keyboard.type('| Name | Role |')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Ada')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Engineer')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Grace')
  await expect(page.locator('.galley-line[data-kind="table-row"]')).toHaveCount(2)
  await expect.poll(() => saved(page, slug)).toBe('| Name | Role |\n| --- | --- |\n| Ada | Engineer |\n| Grace |  |')
})

test('a note on a passage is saved beside the document and comes back', async ({ page }) => {
  const slug = await newDocument(page)
  await page.keyboard.type('The quick brown fox.')
  await expect.poll(() => saved(page, slug)).toBe('The quick brown fox.')
  await page.locator('.galley-line').first().getByText('The quick brown fox.').dblclick({ position: { x: 60, y: 8 } })
  const comment = page.locator('.galley-selection-btn[data-action="comment"]')
  await expect(comment).toBeVisible()
  await comment.click()
  await expect(page.locator('.galley-note-text')).toBeFocused()
  await page.keyboard.type('Too familiar?')
  await page.keyboard.press('Escape')
  await expect(page.locator('.galley-note')).toHaveCount(0)
  await expect.poll(() => savedNotes(page, slug)).toEqual([expect.objectContaining({ snippet: 'quick', comment: 'Too familiar?' })])

  await page.reload()
  await page.waitForFunction((s) => window.galley?.slug === s, slug)
  await expect(page.locator('.galley-mark')).toHaveCount(1)
  await page.locator('.galley-mark').click()
  await expect(page.locator('.galley-note-text')).toHaveValue('Too familiar?')
})

test('a note left empty is not kept', async ({ page }) => {
  const slug = await newDocument(page)
  await page.keyboard.type('Nothing to say here.')
  await page.locator('.galley-line').first().dblclick({ position: { x: 20, y: 8 } })
  await page.locator('.galley-selection-btn[data-action="comment"]').click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.galley-mark')).toHaveCount(0)
  await expect.poll(() => savedNotes(page, slug)).toEqual([])
})

test('notes whose passage is gone are one-line ticks inside the page, however long their paragraph', async ({ page }) => {
  const slug = `gone-${Date.now()}`
  const at = new Date().toISOString()
  writeFileSync(join(process.env.GALLEY_E2E_DIR!, `${slug}.md`), `# Gone\n\n${'Street trees with wider pits live longer than trees in narrow ones. '.repeat(30)}\n`)
  writeFileSync(join(process.env.GALLEY_E2E_DIR!, `${slug}.annotations.json`), JSON.stringify({ annotations: Array.from({ length: 40 }, (_, i) => ({
    id: `gone-${i}`, range: { start_line: 2, start_offset: 0, end_line: 2, end_offset: 12 }, snippet: `A passage since rewritten ${i}`, comment: 'Which study?', created_at: at, updated_at: at,
  })) }))
  await page.goto(`/?doc=${slug}`)
  await expect(page.locator('.galley-mark.is-orphan')).toHaveCount(40)
  const { line, ticks, sideways } = await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll<HTMLElement>('.galley-line')].find((l) => l.textContent?.startsWith('Street trees'))!
    const main = document.querySelector<HTMLElement>('.galley-main')!
    return {
      line: parseFloat(getComputedStyle(paragraph).lineHeight),
      ticks: [...document.querySelectorAll<HTMLElement>('.galley-mark.is-orphan')].map((t) => t.getBoundingClientRect().height),
      sideways: main.scrollWidth - main.clientWidth,
    }
  })
  expect(ticks.every((h) => Math.abs(h - line) < 1)).toBe(true)
  expect(sideways).toBe(0)
})

test('a change made elsewhere merges with yours; where you both changed a line, yours stands and you are told', async ({ page }) => {
  const slug = await newDocument(page)
  await page.keyboard.type('first line')
  await page.keyboard.press('Enter')
  await page.keyboard.type('mine')
  await expect.poll(() => saved(page, slug)).toBe('first line\nmine')
  // Another writer changes the first line; the writer here goes on typing on the second.
  const current = await (await page.request.get(`/api/galley/doc/${slug}`)).json()
  await page.request.put(`/api/galley/doc/${slug}`, {
    data: { content: 'their first line\nmine', client_id: 'elsewhere', revision: 1, base_version: current.version },
  })
  await page.keyboard.type(' and more')
  await expect.poll(() => saved(page, slug)).toBe('their first line\nmine and more')
  await expect(page.locator('.galley-doc')).toContainText('their first line')
  await expect(page.locator('.galley-notice')).toHaveCount(0)
  // Both change the same line: the writer's version stands, and they are told.
  const again = await (await page.request.get(`/api/galley/doc/${slug}`)).json()
  await page.request.put(`/api/galley/doc/${slug}`, {
    data: { content: 'their first line\ntheirs instead', client_id: 'elsewhere', revision: 2, base_version: again.version },
  })
  await page.keyboard.type('!')
  await expect.poll(() => saved(page, slug)).toBe('their first line\nmine and more!')
  await expect(page.locator('.galley-notice')).toContainText('your version stands')
})

test('undo history survives a reload', async ({ page }) => {
  const slug = await newDocument(page)
  await page.keyboard.type('first')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second')
  await expect.poll(() => saved(page, slug)).toBe('first\nsecond')
  await page.reload()
  await page.waitForFunction((s) => window.galley?.slug === s, slug)
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => page.evaluate(() => window.galley.text())).not.toBe('first\nsecond')
})

test('delete asks first, then removes the document', async ({ page }) => {
  const slug = await newDocument(page)
  await page.locator('[data-action="delete"]').click()
  await page.locator('dialog.galley-dialog').getByRole('button', { name: 'Delete' }).click()
  await page.waitForFunction((s) => !!window.galley.slug && window.galley.slug !== s, slug)
  expect((await page.request.get(`/api/galley/doc/${slug}`)).status()).toBe(404)
})

test('the browser store works with no server at all', async ({ page }) => {
  await newDocument(page, '/?store=local')
  await page.keyboard.type('# Offline')
  await page.waitForTimeout(800)
  await page.reload()
  await page.waitForFunction(() => window.galley?.text() === '# Offline')
  await expect(page.locator('.galley-picker-title')).toHaveText('Offline')
})
