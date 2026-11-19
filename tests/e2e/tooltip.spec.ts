// Every control says what it is and what it does when the pointer rests on it.
import { expect, test } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

test('a control shows its name and what it does after half a second, and hides when the pointer leaves', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.galley?.slug)
  const tip = page.locator('.galley-tooltip')
  await page.locator('[data-action="new"]').hover()
  await expect(tip).toHaveCount(0)
  await expect(tip).toBeVisible({ timeout: 2000 })
  await expect(tip).toContainText('New document')
  await expect(tip).toContainText('⌘N')
  await expect(tip).toContainText('Start a new, empty document')
  await expect(page.locator('[data-action="new"]')).toHaveAttribute('aria-describedby', /galley-tooltip/)
  await page.mouse.move(600, 500)
  await expect(tip).toBeHidden()
})
