// A stand-in for the engine in the end-to-end tests. Every command goes to the
// real CLI except `write`, which runs the engine's real start (the project
// takes the seed, the paper is written into the document it started from, the
// seed's notes move with it) and stops before the first model call.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cli = join(root, 'dist', 'engine', 'cli.js')
const [command, ...args] = process.argv.slice(2)
if (command !== 'write') {
  const run = spawnSync(process.execPath, [cli, command, ...args], { stdio: 'inherit' })
  process.exit(run.status ?? 1)
}
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
const [seedFile, dir] = positional
const { readFileSync } = await import('node:fs')
const { Paper } = await import(join(root, 'dist', 'engine', 'paper.js'))
const { syncEditor } = await import(join(root, 'dist', 'engine', 'render.js'))
const paper = Paper.create(resolve(dir), readFileSync(seedFile, 'utf8'), { editorDir: resolve(flag('editor')), editorDoc: flag('editor-doc') })
// The engine syncs while its first model call runs; here it syncs until the paper's first write has landed.
for (let i = 0; i < 40 && !paper.state.editorWritten; i++) {
  syncEditor(paper)
  if (!paper.state.editorWritten) await new Promise((r) => setTimeout(r, 500))
}
