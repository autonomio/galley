// End-to-end tests drive the demo in Chromium against a fresh documents
// folder, through the same dev server `npm run dev` starts.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const PORT = 5199
// Workers inherit the main process's environment, so one folder is shared.
process.env.GALLEY_E2E_DIR ??= mkdtempSync(join(tmpdir(), 'galley-e2e-'))
process.env.GALLEY_E2E_PAPERS ??= mkdtempSync(join(tmpdir(), 'galley-e2e-papers-'))

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 20_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1100, height: 800 },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // The engine's start runs for real; the stand-in stops before the first model call.
    env: { GALLEY_DIR: process.env.GALLEY_E2E_DIR, GALLEY_PAPERS: process.env.GALLEY_E2E_PAPERS, GALLEY_CLI: 'tests/e2e/support/engine.mjs' },
    reuseExistingServer: false,
    stdout: 'ignore',
  },
})
