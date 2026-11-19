// A galley paper in the editor: the person stays in charge of what agents propose.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

test('a proposed change shows its before and after, and Accept applies and records it', async ({ page }) => {
  const dir = process.env.GALLEY_E2E_DIR!
  const slug = `paper-${Date.now()}`
  writeFileSync(join(dir, `${slug}.md`), '# A Paper\n\n## Results\n\nThe method always works in every field.\n')
  writeFileSync(join(dir, `${slug}.proposals.json`), JSON.stringify({
    proposals: [{ id: 'P1', findingId: 'F1-methods-1', description: 'fixed: the evidence covers one field', old: 'always works in every field', new: 'worked in the field it was tested in', state: 'pending' }],
  }))
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  await page.evaluate((s) => window.galley.open(s), slug)
  await page.waitForFunction((s) => window.galley.slug === s, slug)

  await page.locator('[data-action="proposals"]').click()
  const card = page.locator('.demo-proposal')
  await expect(card.locator('.demo-proposal-old')).toHaveText('− always works in every field')
  await expect(card.locator('.demo-proposal-new')).toHaveText('+ worked in the field it was tested in')
  await card.getByRole('button', { name: 'Accept' }).click()

  await expect.poll(async () => (await (await page.request.get(`/api/galley/doc/${slug}`)).json()).content)
    .toContain('The method worked in the field it was tested in.')
  await expect.poll(async () => (await (await page.request.get(`/api/galley-proposals/${slug}`)).json()).proposals[0].state).toBe('accepted')
  await expect(page.locator('.demo-proposals-head')).toContainText('No proposed changes')
})
