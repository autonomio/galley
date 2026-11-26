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
  let posted: { settings: Record<string, unknown>; materials: Record<string, unknown>[]; datasets: Record<string, unknown>[] } | null = null
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
  // The first step asks what to make; nothing is chosen for you.
  await expect(wizard.getByRole('heading', { name: 'What to make' })).toBeVisible()
  await expect(wizard.getByRole('button', { name: 'Next: Seed' })).toBeDisabled()
  await wizard.getByRole('radio', { name: /A paper/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await expect(wizard.getByRole('heading', { name: 'Your seed' })).toBeVisible()
  await expect(wizard.locator('details.gw-seed summary')).toHaveText('Your seed, as you wrote it')
  await expect(wizard).toContainText('this document becomes the paper')
  await wizard.getByRole('button', { name: 'Next: Materials' }).click()
  // Files added together form one dataset, its README with it; where the data comes from is part of it.
  await wizard.getByLabel('Choose files').setInputFiles([
    { name: 'trees.csv', mimeType: 'text/csv', buffer: Buffer.from('id,site,alive\n1,pit,no\n2,park,yes\n3,pit,no\n') },
    { name: 'README.md', mimeType: 'text/markdown', buffer: Buffer.from('# Street trees\nSurvival by site type, 2018 to 2024.\n') },
  ])
  const dataset = wizard.locator('.gw-dataset')
  await expect(dataset).toHaveCount(1)
  await expect(dataset.locator('.gw-row')).toHaveCount(2)
  await expect(dataset).toContainText('3 rows · 3 columns')
  await dataset.getByRole('radiogroup', { name: 'Who produced trees' }).getByRole('radio', { name: 'Others' }).click()
  await dataset.getByLabel('Published as, trees').fill('https://doi.org/10.5281/zenodo.123')
  await expect(dataset).toContainText('never as measurements made for this paper')
  await wizard.getByLabel('Link', { exact: true }).fill('https://example.org/survey')
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
  // With Claude off, GPT writes and Gemini checks.
  await wizard.getByRole('checkbox', { name: 'Claude Opus 5.5' }).uncheck()
  await expect(wizard.locator('.gw-seats tr').first()).toContainText('GPT-6.2 Sol')
  await expect(wizard.getByRole('checkbox', { name: 'GPT-6.2 Sol' })).toBeDisabled()

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

  expect(posted!.settings).toMatchObject({ author: 'Ada Lovelace', rounds: 1, dial: 'autonomous', citations: 'auto', literatureReview: true, reviewRole: 'load-bearing', simulation: true, simulationRole: 'supporting', families: ['gpt', 'gemini'] })
  expect(posted!.materials).toEqual([{ name: 'https://example.org/survey', url: 'https://example.org/survey' }])
  expect(posted!.datasets).toEqual([expect.objectContaining({
    name: 'trees', producedBy: 'others', doi: 'https://doi.org/10.5281/zenodo.123', private: true,
    files: [expect.objectContaining({ name: 'trees.csv' }), expect.objectContaining({ name: 'README.md' })],
  })])
})

test('late context preserves settings after going Back to Materials and submits those choices', async ({ page }) => {
  const slug = `late-context-${Date.now()}`
  writeFileSync(join(process.env.GALLEY_E2E_DIR!, `${slug}.md`), `# Street trees\n\n${'City trees die young in narrow pavement pits. '.repeat(10)}\n`)
  let release = () => {}
  const held = new Promise<void>((done) => { release = done })
  await page.route('**/api/galley-papers/_context', async (route) => {
    await held
    return route.fulfill({ json: {
      modelRevision: 'test-revision', openalexKey: true,
      seats: { author: { family: 'claude', name: 'Claude', model: 'claude' }, checker: { family: 'gpt', name: 'GPT', model: 'gpt' }, challenger: { family: 'gemini', name: 'Gemini', model: 'gemini' }, verifier: { family: 'gemini', name: 'Gemini', model: 'gemini' } },
      referees: ['methods', 'field', 'citations', 'editor'], refereeModels: [], adjudicator: 'gpt',
      defaults: { venue: 'preprint (arXiv)', words: 9000, rounds: 2, dial: 'autonomous', citations: 'auto', simulation: false },
    } })
  })
  let posted: { settings: Record<string, unknown> } | null = null
  await page.route(`**/api/galley-papers/${slug}`, (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 404, body: '' })
    posted = route.request().postDataJSON()
    return route.fulfill({ status: 202, json: {} })
  })
  await page.goto(`/?doc=${slug}`)
  await page.waitForFunction((s) => window.galley?.slug === s, slug)
  await page.locator('[data-action="write-paper"]').click()
  const wizard = page.locator('dialog.gw')
  await wizard.getByRole('radio', { name: /A paper/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await wizard.getByRole('button', { name: 'Next: Materials' }).click()
  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  await wizard.getByLabel('Venue', { exact: true }).fill('journal article')
  await wizard.getByRole('radio', { name: '5,000 words' }).click()
  await wizard.getByRole('checkbox', { name: /Monte Carlo simulation/ }).check()
  await wizard.getByRole('radio', { name: '1 round', exact: true }).click()
  await wizard.getByRole('radio', { name: /Assisted/ }).click()
  await wizard.getByRole('radio', { name: /You pick the load-bearing ones/ }).click()
  await wizard.getByRole('button', { name: 'Back' }).click()
  await expect(wizard.getByRole('heading', { name: 'What the paper draws on' })).toBeVisible()
  const response = page.waitForResponse('**/api/galley-papers/_context')
  release()
  await (await response).finished()
  // Let the response's JSON handler apply while Materials is still open.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  await expect(wizard).toContainText('key found: two searches per claim')
  await wizard.getByRole('button', { name: 'Next: Start' }).click()
  await wizard.getByRole('button', { name: 'Start the paper' }).click()
  await expect(wizard.getByRole('heading', { name: 'Writing the paper' })).toBeVisible()
  expect(posted!.settings).toMatchObject({ venue: 'journal article', words: 5000, rounds: 1, dial: 'assisted', citations: 'mixed', simulation: true })
})

test('late context applies paper defaults after visiting thesis Settings', async ({ page }) => {
  const slug = `thesis-paper-defaults-${Date.now()}`
  writeFileSync(join(process.env.GALLEY_E2E_DIR!, `${slug}.md`), `# Street trees\n\n${'City trees die young in narrow pavement pits. '.repeat(10)}\n`)
  let release = () => {}
  const held = new Promise<void>((done) => { release = done })
  await page.route('**/api/galley-papers/_context', async (route) => {
    await held
    return route.fulfill({ json: {
      modelRevision: 'test-revision', openalexKey: true,
      seats: { author: { family: 'claude', name: 'Claude', model: 'claude' }, checker: { family: 'gpt', name: 'GPT', model: 'gpt' }, challenger: { family: 'gemini', name: 'Gemini', model: 'gemini' }, verifier: { family: 'gemini', name: 'Gemini', model: 'gemini' } },
      referees: ['methods', 'field', 'citations', 'editor'], refereeModels: [], adjudicator: 'gpt',
      defaults: { venue: 'preprint (arXiv)', words: 9000, rounds: 2, dial: 'autonomous', citations: 'auto', simulation: false },
    } })
  })
  let posted: { settings: Record<string, unknown> } | null = null
  await page.route(`**/api/galley-papers/${slug}`, (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 404, body: '' })
    posted = route.request().postDataJSON()
    return route.fulfill({ status: 202, json: {} })
  })
  await page.goto(`/?doc=${slug}`)
  await page.waitForFunction((s) => window.galley?.slug === s, slug)
  await page.locator('[data-action="write-paper"]').click()
  const wizard = page.locator('dialog.gw')
  await wizard.getByRole('radio', { name: /A thesis/ }).click()
  await wizard.getByRole('button', { name: 'Next: Direction' }).click()
  await wizard.getByRole('radio', { name: /Reframe: beyond the flow/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  await expect(wizard.getByRole('heading', { name: 'How the thesis is made' })).toBeVisible()
  for (let i = 0; i < 3; i++) await wizard.getByRole('button', { name: 'Back' }).click()
  await wizard.getByRole('radio', { name: /A paper/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await wizard.getByRole('button', { name: 'Next: Materials' }).click()
  const response = page.waitForResponse('**/api/galley-papers/_context')
  release()
  await (await response).finished()
  // Let the paper defaults arrive before its Settings controls are first drawn.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  await expect(wizard.getByRole('radio', { name: '9,000 words' })).toHaveAttribute('aria-checked', 'true')
  await wizard.getByRole('button', { name: 'Next: Start' }).click()
  await wizard.getByRole('button', { name: 'Start the paper' }).click()
  await expect(wizard.getByRole('heading', { name: 'Writing the paper' })).toBeVisible()
  expect(posted!.settings).toMatchObject({ mode: 'paper', words: 9000 })
})

test('a link to a published dataset becomes a dataset, read from its record and cited by it', async ({ page }) => {
  const dir = process.env.GALLEY_E2E_DIR!
  const slug = `seed-${Date.now()}`
  writeFileSync(join(dir, `${slug}.md`), `# Telecom latency\n\n${'Telecom sites could sell fast frequency reserve if they switch to battery fast enough. '.repeat(10)}\n`)
  let posted: { datasets: Record<string, unknown>[] } | null = null
  await page.route('**/api/galley-papers/_record?**', (route) => route.fulfill({ json: {
    link: 'https://zenodo.org/records/19781923', name: 'VPP latency measurements', creators: ['ICTEnergyFTW'], version: 'v1.0.1', doi: '10.5281/zenodo.19781923', licence: 'CC-BY-4.0', url: 'https://zenodo.org/records/19781923', citation: '', files: [{ name: 'VPP_Latency_Measurements-v1.0.1.zip', size: 3243312, url: '' }],
  } }))
  await page.route(`**/api/galley-papers/${slug}`, async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 404, body: '' })
    posted = route.request().postDataJSON()
    return route.fulfill({ status: 202, json: {} })
  })
  await page.goto(`/?doc=${slug}`)
  await page.waitForFunction((s) => window.galley?.slug === s, slug)
  await page.locator('[data-action="write-paper"]').click()
  const wizard = page.locator('dialog.gw')
  await wizard.getByRole('radio', { name: /A paper/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await wizard.getByRole('button', { name: 'Next: Materials' }).click()
  await wizard.getByLabel('Link', { exact: true }).fill('https://zenodo.org/records/19781923')
  await wizard.getByRole('button', { name: 'Add link' }).click()
  const dataset = wizard.locator('.gw-dataset')
  await expect(dataset).toContainText('Published by ICTEnergyFTW, version v1.0.1, CC-BY-4.0, DOI 10.5281/zenodo.19781923')
  await expect(dataset).toContainText('downloaded and unpacked when the paper starts')
  await expect(dataset).toContainText('never as measurements made for this paper')
  for (const step of ['Next: Settings', 'Next: Start']) await wizard.getByRole('button', { name: step }).click()
  await wizard.getByRole('button', { name: 'Start the paper' }).click()
  await expect(wizard.getByRole('heading', { name: 'Writing the paper' })).toBeVisible()
  expect(posted!.datasets).toEqual([{ record: 'https://zenodo.org/records/19781923', name: 'VPP latency measurements', producedBy: 'others', describedIn: '', private: false }])
})

test('one line connects a database: its databases are listed, one becomes a private dataset, and a saved connection is one click', async ({ page }) => {
  const dir = process.env.GALLEY_E2E_DIR!
  const slug = `seed-${Date.now()}`
  writeFileSync(join(dir, `${slug}.md`), `# Spot trades\n\n${'How often do large trades move the price within a second? '.repeat(10)}\n`)
  let discovery: Record<string, unknown> | null = null
  let discoveryUrl = ''
  let posted: { datasets: Record<string, unknown>[] } | null = null
  let showSaved!: () => void
  const pendingSaved = new Promise<void>((resolve) => { showSaved = resolve })
  await page.route('**/api/galley-papers/_databases', async (route) => {
    if (route.request().method() !== 'POST') {
      await pendingSaved
      return route.fulfill({ json: [{ name: 'markets on db.example.org', kind: 'clickhouse', via: 'http', url: 'https://db.example.org:8443', user: 'reader', database: 'markets' }] })
    }
    discovery = route.request().postDataJSON()
    discoveryUrl = route.request().url()
    return route.fulfill({ json: [{ via: 'ssh', label: 'clickhouse on root@trades.example.org', host: 'root@trades.example.org', container: 'clickhouse', version: '26.8.1', databases: [{ name: 'origo', tables: 41, rows: 8_200_000_000, bytes: 140_000_000_000 }, { name: 'scratch_empty', tables: 5, rows: 0, bytes: 0 }] }] })
  })
  await page.route(`**/api/galley-papers/${slug}`, async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 404, body: '' })
    posted = route.request().postDataJSON()
    return route.fulfill({ status: 202, json: {} })
  })
  await page.goto(`/?doc=${slug}`)
  await page.waitForFunction((s) => window.galley?.slug === s, slug)
  await page.locator('[data-action="write-paper"]').click()
  const wizard = page.locator('dialog.gw')
  await wizard.getByRole('radio', { name: /A paper/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await wizard.getByRole('button', { name: 'Next: Materials' }).click()

  await wizard.getByLabel('Database connection').fill('root@trades.example.org')
  showSaved()
  await expect(wizard.getByRole('button', { name: 'Use markets on db.example.org' })).toBeVisible()
  await expect(wizard.getByLabel('Database connection')).toHaveValue('root@trades.example.org')
  await wizard.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(wizard.locator('.gw-row', { hasText: 'origo' })).toContainText('41 tables')
  expect(discovery).toEqual({ line: 'root@trades.example.org' })
  expect(discoveryUrl).not.toContain('trades.example.org')
  await expect(wizard.locator('.gw-row', { hasText: 'scratch_empty' })).toBeHidden()
  await expect(wizard.getByRole('button', { name: 'Show all 2 databases' })).toBeVisible()
  await wizard.getByRole('button', { name: 'Use origo' }).click()
  await expect(wizard.locator('.gw-dataset', { hasText: 'Database origo' })).toContainText('Read-only')
  await wizard.getByRole('button', { name: 'Use markets on db.example.org' }).click()
  await expect(wizard.locator('.gw-dataset')).toHaveCount(2)

  for (const step of ['Next: Settings', 'Next: Start']) await wizard.getByRole('button', { name: step }).click()
  await wizard.getByRole('button', { name: 'Start the paper' }).click()
  await expect(wizard.getByRole('heading', { name: 'Writing the paper' })).toBeVisible()
  expect(posted!.datasets).toEqual([
    { database: expect.objectContaining({ line: 'root@trades.example.org', via: 'ssh', host: 'root@trades.example.org', container: 'clickhouse', database: 'origo' }), name: 'origo', producedBy: 'authors', private: true },
    { database: expect.objectContaining({ connection: 'markets on db.example.org', database: 'markets' }), name: 'markets', producedBy: 'authors', private: true },
  ])
})

test('a world model as the sources: read once, only its sources by default, and no review or web search with it', async ({ page }) => {
  const dir = process.env.GALLEY_E2E_DIR!
  const slug = `seed-${Date.now()}`
  writeFileSync(join(dir, `${slug}.md`), `# Bounded attention\n\n${'Why can attention be fast only when its entries are bounded? '.repeat(10)}\n`)
  let uploaded = ''
  let posted: { settings: Record<string, unknown>; worldModel?: Record<string, unknown> } | null = null
  await page.route('**/api/galley-papers/_world-model?**', (route) => {
    uploaded = route.request().url()
    return route.fulfill({ json: { token: 'a1b2c3d4e5f6a1b2c3d4e5f6', name: 'attention-model', sha256: 'abc', claims: 359, evidence: 404, sources: 1402, relations: 163 } })
  })
  await page.route(`**/api/galley-papers/${slug}`, async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 404, body: '' })
    posted = route.request().postDataJSON()
    return route.fulfill({ status: 202, json: {} })
  })
  await page.goto(`/?doc=${slug}`)
  await page.waitForFunction((s) => window.galley?.slug === s, slug)
  await page.locator('[data-action="write-paper"]').click()
  const wizard = page.locator('dialog.gw')
  await wizard.getByRole('radio', { name: /A paper/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await wizard.getByRole('button', { name: 'Next: Materials' }).click()
  await wizard.getByLabel('Choose a world model').setInputFiles({ name: 'attention-model-main.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') })
  const card = wizard.getByRole('region', { name: 'World model' })
  await expect(card).toContainText('World model: 359 claims, 404 evidence records, 1,402 sources with their passages.')
  expect(uploaded).toContain('name=attention-model-main.zip')
  await expect(card.getByRole('radio', { name: 'Only this world model' })).toHaveAttribute('aria-checked', 'true')

  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  await expect(wizard).toContainText('No systematic review: the paper\'s sources are only its world model\'s.')
  await expect(wizard.getByRole('checkbox', { name: 'Primary sources from the web' })).toBeDisabled()
  await wizard.getByRole('button', { name: 'Next: Start' }).click()
  await expect(wizard).toContainText('the world model searched for each claim')
  await wizard.getByRole('button', { name: 'Start the paper' }).click()
  await expect(wizard.getByRole('heading', { name: 'Writing the paper' })).toBeVisible()
  expect(posted!.worldModel).toEqual({ token: 'a1b2c3d4e5f6a1b2c3d4e5f6', only: true })
  expect([posted!.settings.literatureReview, posted!.settings.webSources]).toEqual([false, false])
})

test('a world model that failed on the paper\'s Materials step does not stop a thesis, and a start under way is sent once', async ({ page }) => {
  const dir = process.env.GALLEY_E2E_DIR!
  const slug = `thesis-once-${Date.now()}`
  writeFileSync(join(dir, `${slug}.md`), `# Street trees\n\n${'City trees die young in narrow pavement pits. '.repeat(20)}\n`)
  await page.route('**/api/galley-papers/_world-model?**', (route) => route.fulfill({ status: 500, body: 'the zip could not be read' }))
  const posts: { worldModel?: unknown }[] = []
  let release = () => {}
  const held = new Promise<void>((done) => { release = done })
  await page.route(`**/api/galley-papers/${slug}`, async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 404, body: '' })
    posts.push(route.request().postDataJSON())
    await held
    return route.fulfill({ status: 202, json: {} })
  })
  await page.goto(`/?doc=${slug}`)
  await page.waitForFunction((s) => window.galley?.slug === s, slug)
  await page.locator('[data-action="write-paper"]').click()
  const wizard = page.locator('dialog.gw')
  await wizard.getByRole('radio', { name: /A paper/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await wizard.getByRole('button', { name: 'Next: Materials' }).click()
  await wizard.getByLabel('Choose a world model').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') })
  await expect(wizard.getByRole('region', { name: 'World model' })).toContainText('Not read')
  // Back to the start, for a thesis instead: it takes no materials.
  await wizard.getByRole('button', { name: 'Back' }).click()
  await wizard.getByRole('button', { name: 'Back' }).click()
  await wizard.getByRole('radio', { name: /A thesis/ }).click()
  await wizard.getByRole('button', { name: 'Next: Direction' }).click()
  await wizard.getByRole('radio', { name: /Reframe: beyond the flow/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  await wizard.getByLabel('Name').fill('Ada Lovelace')
  await wizard.getByRole('button', { name: 'Next: Start' }).click()
  await wizard.getByRole('button', { name: 'Start the thesis' }).click()
  // While the start is out, neither Back nor a second press can send it again.
  await expect(wizard.getByRole('button', { name: 'Starting…' })).toBeDisabled()
  await expect(wizard.getByRole('button', { name: 'Back' })).toBeDisabled()
  release()
  await expect(wizard.getByRole('heading', { name: 'Formulating the thesis' })).toBeVisible()
  expect(posts).toHaveLength(1)
  expect(posts[0].worldModel).toBeUndefined()
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
    seed: 'City trees die young in narrow pavement pits.',
    settings: { literatureReview: true, simulation: false, rounds: 2, words: 7000, venue: 'preprint (arXiv)', authors: ['Ada Lovelace'], materials: ['trees.csv (private dataset)'] },
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
  await status.locator('details.gw-seed summary').click()
  await expect(status.locator('details.gw-seed')).toContainText('City trees die young in narrow pavement pits.')
  await expect(status.locator('details.gw-seed')).toContainText('yes, supporting')
  await status.getByRole('button', { name: 'Close' }).click()
  await expect(status).toHaveCount(0)

  data = { ...data, outcome: 'ready_for_submission', running: false, typeset: true, waiting: null, stages: (data.stages as { label: string }[]).map((s) => stage(s.label, true)) }
  await page.locator('[data-action="write-paper"]').click()
  await expect(status.locator('.gw-state')).toHaveText('✓Ready for submission')
  await status.getByRole('button', { name: 'Open the manuscript' }).click()
  await page.waitForFunction((s) => window.galley.slug === s, `${slug}-paper`)
})

test('the status window keeps the seed unfolded through its 10-second refresh', async ({ page }) => {
  const slug = `seed-${Date.now()}`
  writeFileSync(join(process.env.GALLEY_E2E_DIR!, `${slug}.md`), '# Street trees\n\nA seed.\n')
  let calls = 17
  const data = () => ({
    slug, title: 'Pit Size and Street-Tree Survival', seedTitle: 'Street trees', startedAt: '2026-11-19T14:01:00.000Z', outcome: null, running: true, typeset: false, waiting: null,
    now: [{ doing: 'Drafting', who: 'claude-opus-5-5', seconds: 30 }],
    stages: ['Seed', 'Aim', 'Plan', 'Evidence', 'Draft', 'Review', 'Finish'].map((label, i) => ({ id: label.toLowerCase(), label, done: i < 4 })),
    claims: { total: 12, supported: 3, narrowed: 1, own: 6, premises: 1, hypotheses: 1, open: 0 },
    evidence: { screened: 140, verified: 4, rejected: 9 }, sections: { drafted: 2, total: 8 },
    review: { round: 0, rounds: 2, findings: 0, open: 0 }, cost: { calls, tokensInM: 0.7, hours: 0.8 },
    seed: 'City trees die young in narrow pavement pits.',
    settings: { literatureReview: false, simulation: false, rounds: 2, words: 3000, venue: 'preprint (arXiv)', authors: [], materials: [] },
  })
  await page.route(`**/api/galley-papers/${slug}`, (route) => route.fulfill({ json: { data: data() } }))
  await page.clock.install()
  await page.goto(`/?doc=${slug}`)
  await page.waitForFunction((s) => window.galley?.slug === s, slug)

  await page.locator('[data-action="write-paper"]').click()
  const status = page.locator('dialog.gw--status')
  await status.locator('details.gw-seed summary').click()
  calls = 18
  await page.clock.fastForward(10_000)
  await expect(status).toContainText('18 model calls')
  await expect(status.locator('details.gw-seed')).toHaveAttribute('open', '')
  await expect(status.locator('details.gw-seed blockquote')).toBeVisible()
})

test('the wizard makes a thesis: its direction first, then the seed, the author and the account, and starts it with them', async ({ page }) => {
  const dir = process.env.GALLEY_E2E_DIR!
  const slug = `thesis-${Date.now()}`
  writeFileSync(join(dir, `${slug}.md`), `# Street trees\n\n${'City trees die young in narrow pavement pits. '.repeat(20)}\n`)
  let posted: { settings: Record<string, unknown>; materials: unknown[]; datasets: unknown[] } | null = null
  await page.route('**/api/galley-papers/_context', (route) => route.fulfill({ json: {
    openalexKey: true,
    seats: { author: { family: 'claude', name: 'Claude Opus 5.5', model: 'claude-opus-5-5' }, checker: { family: 'gpt', name: 'GPT-6.2 Sol', model: 'gpt-6.2-sol' }, challenger: { family: 'gemini', name: 'Gemini 4 Carbon', model: 'gemini-4-carbon-high' }, verifier: { family: 'gemini', name: 'Gemini 4 Carbon', model: 'gemini-4-carbon-high' } },
    referees: ['methods', 'field', 'citations', 'editor'],
    defaults: { venue: 'preprint (arXiv)', words: 7000, rounds: 2, dial: 'autonomous', citations: 'auto', literatureReview: false, simulation: false },
    review: { research: 'gpt-6.1-sol', audit: 'gpt-6-astra', papers: 50 },
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
  await wizard.getByRole('radio', { name: /A thesis/ }).click()
  // A thesis takes its direction first: extend, contest or reframe, with none chosen for you.
  await wizard.getByRole('button', { name: 'Next: Direction' }).click()
  await expect(wizard.getByRole('heading', { name: 'The thesis\'s direction' })).toBeVisible()
  await expect(wizard.getByRole('button', { name: 'Next: Seed' })).toBeDisabled()
  await expect(wizard.getByRole('radiogroup', { name: 'Direction' }).getByRole('radio')).toHaveCount(3)
  await wizard.getByRole('radio', { name: /Reframe: beyond the flow/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await expect(wizard).toContainText('The thesis starts from your words')
  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  await expect(wizard.getByRole('heading', { name: 'How the thesis is made' })).toBeVisible()
  await expect(wizard).not.toContainText('Referee rounds')
  await wizard.getByLabel('Name').fill('Ada Lovelace')
  await wizard.getByRole('button', { name: 'Next: Start' }).click()
  await expect(wizard.locator('.gw-plan')).toContainText('Literature review')
  await expect(wizard.locator('.gw-plan')).toContainText('Formulate the thesis')
  await expect(wizard.locator('.gw-plan')).toContainText('Test it')
  await expect(wizard.locator('.gw-plan')).not.toContainText('Draft')
  await wizard.getByRole('button', { name: 'Start the thesis' }).click()
  await expect(wizard.getByRole('heading', { name: 'Formulating the thesis' })).toBeVisible()

  expect(posted!.settings).toMatchObject({ mode: 'thesis', stance: 'reframe', author: 'Ada Lovelace' })
  expect(posted!.materials).toEqual([])
  expect(posted!.datasets).toEqual([])
})

for (const role of ['introduction', 'instrument'] as const) test(`a linked commit is used for the selected ${role} role`, async ({ page }) => {
  const label = role === 'introduction' ? 'Introduce our software' : 'Use as an instrument'
  const slug = `software-${Date.now()}`
  const sha = '0123456789abcdef'.repeat(2) + '01234567'
  const commit = `https://github.com/example/solver/commit/${sha}`
  writeFileSync(join(process.env.GALLEY_E2E_DIR!, `${slug}.md`), `# Solver\n\nIntroduce the software at ${commit}. We designed it to solve a documented numerical problem on prepared data, with examples that show what it contributes, how it works in practice, and where a researcher can reproduce the results from the released source code.\n`)
  const gpt = { family: 'gpt', name: 'GPT', model: 'gpt-primary' }
  const gemini = { family: 'gemini', name: 'Gemini', model: 'gemini-secondary' }
  let posted: Record<string, unknown> | undefined
  await page.route('**/api/galley-papers/_context', (route) => route.fulfill({ json: {
    modelRevision: 'gpt-gemini',
    providers: ['OpenAI', 'Google'], families: [gpt, gemini], choices: {},
    seats: { author: gpt, checker: gemini, challenger: gemini, verifier: gemini },
    referees: ['methods', 'field', 'citations', 'editor'],
    refereeModels: ['gemini-secondary', 'gpt-tertiary', 'gemini-secondary', 'gpt-tertiary'],
    adjudicator: 'gpt-tertiary',
    defaults: { venue: 'preprint (arXiv)', words: 7000, rounds: 2, dial: 'autonomous', citations: 'auto' },
  } }))
  await page.route(`**/api/galley-papers/${slug}`, (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 404 })
    posted = route.request().postDataJSON()
    return route.fulfill({ status: 202, json: {} })
  })
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  await page.evaluate((s) => window.galley.open(s), slug)
  await page.waitForFunction((s) => window.galley.slug === s, slug)
  await page.locator('[data-action="write-paper"]').click()
  const wizard = page.locator('dialog.gw')
  await wizard.getByRole('radio', { name: /A paper/ }).click()
  await wizard.getByRole('button', { name: 'Next: Seed' }).click()
  await wizard.getByRole('button', { name: 'Next: Materials' }).click()
  const software = wizard.getByLabel('Software', { exact: true })
  await expect(software).toHaveValue('')
  await expect(wizard.getByRole('radiogroup', { name: 'Role in the paper' })).toBeHidden()
  await wizard.getByRole('button', { name: 'Use commit from seed' }).click()
  await expect(software).toHaveValue(commit)
  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  await expect(wizard.getByRole('alert')).toContainText('Choose how this paper will use the software.')
  await software.fill('https://github.com/example/solver')
  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  await expect(software).toBeVisible()
  await expect(software).toBeFocused()
  await software.fill(commit)
  await wizard.getByLabel('Link', { exact: true }).fill('https://github.com/example/reference')
  await wizard.getByRole('button', { name: 'Add link' }).click()
  await wizard.getByRole('radio', { name: new RegExp(label) }).check()
  await wizard.getByRole('button', { name: 'Next: Settings' }).click()
  const review = wizard.getByRole('checkbox', { name: /Systematic literature review/ })
  if (role === 'introduction') {
    await expect(review).toBeChecked()
    await expect(wizard.getByRole('radio', { name: 'Main contribution' })).toHaveCount(0)
  } else await expect(review).not.toBeChecked()
  await wizard.getByRole('button', { name: 'Next: Start' }).click()
  await expect(wizard.locator('.gw-plan')).toContainText(`example/solver · ${sha.slice(0, 12)}`)
  await expect(wizard.locator('.gw-plan')).toContainText(role === 'introduction' ? 'run validation, benchmarks and profiling' : 'capture study results')
  await expect(wizard.locator('.gw-plan')).toContainText(label)
  await expect(wizard.locator('.gw-plan')).toContainText('gpt-primary')
  await expect(wizard.locator('.gw-plan')).not.toContainText('Claude')
  await wizard.getByRole('button', { name: 'Start the paper' }).click()
  await expect(wizard.getByRole('heading', { name: 'Writing the paper' })).toBeVisible()
  expect(posted).toMatchObject({
    softwareCommit: commit,
    softwareRole: role,
    modelRevision: 'gpt-gemini',
    materials: [{ name: 'https://github.com/example/reference', url: 'https://github.com/example/reference' }],
    settings: { literatureReview: role === 'introduction', reviewRole: 'supporting' },
  })
})
