import { expect, test } from '@playwright/test'

test('model settings save a slot and a role and carry them into the paper context', async ({ page, request }) => {
  const url = '/api/galley-models'
  const initial = await (await request.get(url)).json()
  await page.goto('/')
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible()
  const primary = page.getByLabel('Primary model', { exact: true })
  await expect(primary).toHaveValue(initial.slots.primary)
  try {
    await primary.selectOption('gpt-6.2-sol-high')
    await expect(primary).toHaveValue('gpt-6.2-sol-high')
    const author = page.getByRole('group', { name: 'Author', exact: true })
    await author.getByRole('button', { name: 'Secondary' }).click()
    await expect(author.getByRole('button', { name: 'Secondary' })).toHaveAttribute('aria-pressed', 'true')
    await page.reload()
    await expect(primary).toHaveValue('gpt-6.2-sol-high')
    await expect(author.getByRole('button', { name: 'Secondary' })).toHaveAttribute('aria-pressed', 'true')

    const context = await (await request.get('/api/galley-papers/_context')).json()
    expect(context.seats.author).toEqual({ family: 'gpt', name: 'gpt-6.2-sol', model: initial.slots.secondary })
    const stale = await request.put(url, { data: { revision: initial.revision, place: 'checker', slot: 'primary' } })
    expect(stale.status()).toBe(409)
    const changed = await request.post('/api/galley-papers/welcome', { data: { text: 'A paper seed.', modelRevision: initial.revision } })
    expect(changed.status()).toBe(409)
    expect(await changed.text()).toContain('Model settings changed')
  } finally {
    const current = await (await request.get(url)).json()
    const revertedSlots = await request.put(url, { data: { revision: current.revision, slots: initial.slots } })
    expect(revertedSlots.ok()).toBe(true)
    const reverted = await revertedSlots.json()
    expect((await request.put(url, { data: { revision: reverted.revision, place: 'author', slot: initial.places.author } })).ok()).toBe(true)
  }
})
