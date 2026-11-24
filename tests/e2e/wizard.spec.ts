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
    modelRevision: 'test-revision',
    openalexKey: true,
    seats: { author: { family: 'claude', name: 'Claude Opus 5.5', model: 'claude-opus-5-5' }, checker: { family: 'gpt', name: 'GPT-6.2 Sol', model: 'gpt-6.2-sol' }, challenger: { family: 'gemini', name: 'Gemini 4 Carbon', model: 'gemini-4-carbon-high' }, verifier: { family: 'gemini', name: 'Gemini 4 Carbon', model: 'gemini-4-carbon-high' } },
    referees: ['methods', 'field', 'citations', 'editor'],
    refereeModels: ['gpt-6.2-sol-xhigh', 'gemini-4-carbon-high', 'gpt-6.2-sol-xhigh', 'gemini-4-carbon-high'],
    defaults: { venue: 'preprint (arXiv)', words: 7000, rounds: 2, dial: 'autonomous', citations: 'auto', literatureReview: false, simulation: false },
    review: { research: 'gpt-6.1-sol', audit: 'gpt-6.1-sol', papers: 50 },
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
  await wizard.getByRole('checkbox', { name: /Systematic literature review/ }).check()
  await wizard.getByRole('checkbox', { name: /Monte Carlo simulation/ }).check()
  await wizard.getByRole('radiogroup', { name: 'Systematic literature review: its part in the paper' }).getByRole('radio', { name: 'Main contribution' }).click()
  await expect(wizard).toContainText('The paper is the systematic review')
  await expect(wizard).toContainText('key found: two searches per claim')

  await wizard.getByRole('button', { name: 'Next: Start' }).click()
  await expect(wizard).toContainText('Measure your data')
  await expect(wizard).toContainText('Systematic review')
  await expect(wizard).toContainText('Review question')
  await expect(wizard.locator('.gw-plan')).toContainText('Simulate')
  await expect(wizard.locator('.gw-plan')).toContainText('the plan waits for it')
  await expect(wizard.locator('.gw-plan')).toContainText('gpt-6.1-sol research · gpt-6.1-sol audit')
  await expect(wizard.locator('.gw-plan')).toContainText('without a fixed time limit')
  await expect(wizard).toContainText('never leave this machine')
  await wizard.getByRole('button', { name: 'Start the paper' }).click()
  await expect(wizard.getByRole('heading', { name: 'Writing the paper' })).toBeVisible()

  expect(posted!.settings).toMatchObject({ author: 'Ada Lovelace', rounds: 1, dial: 'autonomous', citations: 'auto', literatureReview: true, reviewRole: 'load-bearing', simulation: true, simulationRole: 'supporting' })
  expect(posted!.materials).toEqual([
    expect.objectContaining({ name: 'trees.csv', private: true }),
    { name: 'https://example.org/survey', url: 'https://example.org/survey' },
  ])
})

test('a seed that already has a paper shows where the paper stands, and opens the manuscript once it is typeset', async ({ page }) => {
  const dir = process.env.GALLEY_E2E_DIR!
  const slug = `seed-${Date.now()}`
  writeFileSync(join(dir, `${slug}.md`), '# Street trees\n\nA seed.\n')
  writeFileSync(join(dir, `${slug}-paper.md`), '# Pit Size and Street-Tree Survival\n\nThe manuscript.\n')
  const stage = (label: string, done: boolean) => ({ id: label.toLowerCase(), label, done })
  const base = {
    slug: `${slug}-paper`, title: 'Pit Size and Street-Tree Survival', seedTitle: 'Street trees', startedAt: '2026-11-19T14:01:00.000Z', now: [],
    claims: { total: 12, supported: 3, narrowed: 1, own: 6, premises: 1, hypotheses: 1, open: 0 },
    evidence: { screened: 140, verified: 4, rejected: 9 }, sections: { drafted: 0, total: 8 },
    review: { round: 0, rounds: 2, findings: 0, open: 0 }, cost: { calls: 17, tokensInM: 0.7, hours: 0.8 },
  }
  let data: Record<string, unknown> = {
    ...base, outcome: null, running: true, typeset: false,
    stages: [stage('Seed', true), stage('Aim', true), stage('Plan', true), stage('Evidence', false), stage('Draft', false), stage('Review', false), stage('Finish', false)],
    waiting: { family: 'gemini', name: 'Gemini 4 Carbon', seconds: 840, resetsIn: 1320 },
  }
  await page.route(`**/api/galley-papers/${slug}`, (route) => route.fulfill({ json: { data } }))
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  await page.evaluate((s) => window.galley.open(s), slug)
  await page.waitForFunction((s) => window.galley.slug === s, slug)

  await page.locator('[data-action="write-paper"]').click()
  const status = page.locator('dialog.gw--status')
  await expect(status.getByRole('heading', { name: 'Pit Size and Street-Tree Survival' })).toBeVisible()
  await expect(status.locator('.gw-state')).toHaveText('Running · Evidence')
  await expect(status.locator('.gw-stages li.is-done')).toHaveCount(3)
  await expect(status.locator('.gw-now')).toContainText('Waiting for Gemini 4 Carbon')
  await expect(status.locator('.gw-now')).toContainText('resets in 22 min')
  await expect(status.locator('.gw-now')).toContainText('next try in 14 min')
  await expect(status.getByRole('button', { name: 'Open the manuscript' })).toBeHidden()
  await status.getByRole('button', { name: 'Close' }).click()
  await expect(status).toHaveCount(0)

  data = { ...data, outcome: 'ready_for_submission', running: false, typeset: true, waiting: null, stages: (data.stages as { label: string }[]).map((s) => stage(s.label, true)) }
  await page.locator('[data-action="write-paper"]').click()
  await expect(status.locator('.gw-state')).toHaveText('✓Ready for submission')
  await status.getByRole('button', { name: 'Open the manuscript' }).click()
  await page.waitForFunction((s) => window.galley.slug === s, `${slug}-paper`)
})
