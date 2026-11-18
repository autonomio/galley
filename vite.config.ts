// `npm run dev` serves the demo (demo/) with Galley's API mounted, keeping
// documents as markdown files in GALLEY_DIR (default ./.galley-data). An
// empty folder starts with the welcome document.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { galleyVitePlugin } from './src/server/vite.js'

const dir = resolve(process.env.GALLEY_DIR || '.galley-data')

export default defineConfig(({ command }) => {
  if (command === 'serve') {
    mkdirSync(dir, { recursive: true })
    if (!readdirSync(dir).some((name) => name.endsWith('.md'))) {
      writeFileSync(resolve(dir, 'welcome.md'), readFileSync(resolve('demo/welcome.md'), 'utf8'))
    }
  }
  return {
    root: 'demo',
    plugins: [galleyVitePlugin({ dir })],
    server: {
      port: Number(process.env.PORT || 5174),
      strictPort: !!process.env.PORT,
      fs: { allow: ['..'] },
    },
    build: {
      outDir: '../dist-demo',
      emptyOutDir: true,
    },
  }
})
