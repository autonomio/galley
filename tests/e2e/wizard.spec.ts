// From a seed to a paper: the wizard collects the materials and the settings
// that change the outcome, and Start sends exactly what was chosen.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

test('the paper wizard walks through seed, materials and settings, and starts the paper with all of them', async ({ page }) => {
  const dir = process.env.GALLEY_E2E_DIR!
  const slug = `seed-${Date.now()}`
  writeFileSync(join(dir, `${slug}.md`), `# Street trees\n\n${'City trees die young in narrow pavement pits. '.repeat(20)}\n`)
  let posted: { settings: Record<string, unknown>; materials: Record<string, unknown>[] } | null = null
  await page.route('**/api/galley-papers/_context', (route) => route.fulfill({ json: {
    openalexKey: true,
    seats: { author: { family: 'claude', name: 'Claude Opus 5.5', model: 'claude-opus-5-5' }, checker: { family: 'gpt', name: 'GPT-6.2 Sol', model: 'gpt-6.2-sol' }, challenger: { family: 'gemini', name: 'Gemini 4 Carbon', model: 'gemini-4-carbon-high' }, verifier: { family: 'gemini', name: 'Gemini 4 Carbon', model: 'gemini-4-carbon-high' } },
    referees: ['methods', 'field', 'citations', 'editor'],
    defaults: { venue: 'preprint (arXiv)', words: 7000, rounds: 2, dial: 'autonomous', citations: 'auto' },
  } }))
  await page.route(`**/api/galley-papers/${slug}`, async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 404, body: '' })
    posted = route.request().postDataJSON()
    return route.fulfill({ status: 202, json: {} })
  })
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  await page.evaluate((s) => window.galley.open(s), slug)
  await page.waitForFunction((s) => window.galley.slug === s, slug)

  await page.locator('[data-action="write-paper"]').click()
  const wizard = page.locator('dialog.gw')
  await expect(wizard.getByRole('heading', { name: 'Your seed' })).toBeVisible()
  await wizard.getByRole('button', { name: 'Next: Materials' }).click()
  await wizard.locator('input[type=file]').setInputFiles({ name: 'trees.csv', mimeType: 'text/csv', buffer: Buffer.from('id,site,alive\n1,pit,no\n2,park,yes\n3,pit,no\n') })
  await expect(wizard.locator('.gw-row')).toContainText('3 rows · 3 columns')
  await wizard.getByLabel('Link').fill('https://example.org/survey')
  await wizard.getByRole('button', { name: 'Add link' }).click()
  await expect(wizard).toContainText('Private datasets stay on this machine')

  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  await wizard.getByLabel('Name').fill('Ada Lovelace')
  await wizard.getByRole('radio', { name: '1 round' }).click()
  await expect(wizard).toContainText('key found: two searches per claim')

  await wizard.getByRole('button', { name: 'Next: Start' }).click()
  await expect(wizard).toContainText('Measure your data')
  await expect(wizard).toContainText('never leave this machine')
  await wizard.getByRole('button', { name: 'Start the paper' }).click()
  await expect(wizard.getByRole('heading', { name: 'Writing the paper' })).toBeVisible()

  expect(posted!.settings).toMatchObject({ author: 'Ada Lovelace', rounds: 1, dial: 'autonomous', citations: 'auto' })
  expect(posted!.materials).toEqual([
    expect.objectContaining({ name: 'trees.csv', private: true }),
    { name: 'https://example.org/survey', url: 'https://example.org/survey' },
  ])
})
