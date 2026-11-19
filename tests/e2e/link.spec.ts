// A paper can be linked to: ?doc=<name> opens that document.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

declare global {
  interface Window { galley: import('../../src/index.js').Editor }
}

test('?doc= opens the named document', async ({ page }) => {
  const slug = `linked-${Date.now()}`
  writeFileSync(join(process.env.GALLEY_E2E_DIR!, `${slug}.md`), '# A linked paper\n\nIt opens from its link.\n')
  await page.goto(`/?doc=${slug}`)
  await page.waitForFunction((s) => window.galley?.slug === s, slug)
  await expect(page.locator('body')).toContainText('It opens from its link.')
})
