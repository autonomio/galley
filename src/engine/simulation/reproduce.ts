// The reproduction package a paper publishes beside it: each simulation's spec with its seed, the
// numbers the paper cites, and the engine that produced them in one file with no dependencies, with
// a command that reruns and verifies every number and a page that does the same in a browser. A
// reader needs Node alone, or only a browser.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { citable } from './cite.js'
import { ENGINE } from './core.js'
import { DISTRIBUTIONS } from './distributions.js'
import { specGuide } from './guide.js'
import type { PageData } from './page.js'
import { fingerprint } from './random.js'
import type { SimulationResult } from './types.js'
import { expectedOf } from './verify.js'

/** One simulation a paper publishes: the engine's result, and why its author built it so. */
export interface PublishedRun {
  id: string
  title: string
  /** What the simulation shows for the paper. */
  purpose: string
  /** Where each input's distribution comes from. */
  assumptions: { name: string; basis: string }[]
  result: SimulationResult
}

// ---------------------------------------------------------------- the engine in one file

/** The modules the package runs, by their path under the engine's root, and what it takes from each. */
const ENTRIES: Record<string, string[]> = {
  'simulation/core.js': ['simulate', 'validate', 'ENGINE'],
  'simulation/cite.js': ['citable', 'placeholders'],
  'simulation/verify.js': ['compare', 'expectedOf', 'main', 'USAGE'],
  'simulation/page.js': ['mount'],
}

const HERE = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(HERE))
// A built galley runs from dist/, where the compiled modules sit beside this one; under a test it
// runs from src/, and the same modules are compiled here, one by one, without type checking.
const FROM_SOURCE = HERE.endsWith('.ts')

interface TypeScript {
  transpileModule(text: string, options: { compilerOptions: Record<string, unknown> }): { outputText: string }
  ModuleKind: { ESNext: unknown }
  ScriptTarget: { ES2022: unknown }
}

function moduleText(path: string): string {
  if (!FROM_SOURCE) return readFileSync(join(ROOT, path), 'utf8')
  const ts = createRequire(import.meta.url)('typescript') as TypeScript
  const source = readFileSync(join(ROOT, path.replace(/\.js$/, '.ts')), 'utf8')
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true } }).outputText
}

const IMPORT = /^import\s+(?:\{([^}]*)\}|\*\s+as\s+([A-Za-z_$][\w$]*))\s+from\s+(['"])([^'"]+)\3;?[ \t]*$/gm
const EXPORT_FROM = /^export\s+\{([^}]*)\}\s+from\s+(['"])([^'"]+)\2;?[ \t]*$/gm
const EXPORT_LIST = /^export\s+\{([^}]*)\};?[ \t]*$/gm
const EXPORT_DECL = /^export\s+((?:async\s+)?function\*?|const|let|var|class)(\s+)([A-Za-z_$][\w$]*)/gm

const specifiers = (list: string) => list.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type '))
  .map((s) => { const [from, to = from] = s.split(/\s+as\s+/); return { from, to } })
const destructure = (list: string) => `{ ${specifiers(list).map((s) => (s.from === s.to ? s.from : `${s.from}: ${s.to}`)).join(', ')} }`

function resolve(from: string, spec: string): string {
  if (!spec.startsWith('.')) throw new Error(`${from} imports ${spec}: the published engine may import nothing outside itself`)
  const path = posix.normalize(posix.join(posix.dirname(from), spec))
  if (path.startsWith('..')) throw new Error(`${from} imports ${spec}, which is outside the engine`)
  return path
}

/**
 * One module as a function in the bundle: its imports become lookups of the modules they name, and
 * its exports the object it returns. It handles the statements the compiler emits for the engine,
 * and refuses anything else rather than guess.
 */
function wrap(path: string, js: string, deps: string[]): string {
  const exported: string[] = []
  const load = (spec: string) => {
    const target = resolve(path, spec)
    deps.push(target)
    return `__load(${JSON.stringify(target)})`
  }
  const body = js
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
    .replace(IMPORT, (_m, list: string | undefined, ns: string | undefined, _q, spec: string) => `const ${ns ?? destructure(list ?? '')} = ${load(spec)};`)
    .replace(EXPORT_FROM, (_m, list: string, _q, spec: string) => {
      exported.push(...specifiers(list).map((s) => s.to))
      return `const ${destructure(list)} = ${load(spec)};`
    })
    .replace(EXPORT_LIST, (_m, list: string) => {
      exported.push(...specifiers(list).map((s) => (s.from === s.to ? s.from : `${s.to}: ${s.from}`)))
      return ''
    })
    .replace(EXPORT_DECL, (_m, kind: string, space: string, name: string) => {
      exported.push(name)
      return `${kind}${space}${name}`
    })
  const left = /^[ \t]*(?:import|export)\b.*$/m.exec(body) ?? /\bimport\s*(?:\.\s*meta\b|\()/.exec(body)
  if (left) throw new Error(`${path}: the bundle cannot carry “${left[0].trim()}”`)
  return `__define(${JSON.stringify(path)}, () => {\n${body.trim()}\nreturn { ${exported.join(', ')} };\n});`
}

/** The engine as one ES module with no imports: the very code galley ran, gathered from its own modules. */
export function bundleEngine(): string {
  const order: string[] = []
  const wrapped = new Map<string, string>()
  const visit = (path: string) => {
    if (wrapped.has(path)) return
    const deps: string[] = []
    wrapped.set(path, wrap(path, moduleText(path), deps))
    deps.forEach(visit)
    order.push(path)
  }
  Object.keys(ENTRIES).forEach(visit)
  const names = Object.values(ENTRIES).flat()
  return [
    `// The simulation engine of galley (${ENGINE}) in one file: the code that produced the paper's numbers,`,
    '// gathered from galley\'s own modules, with no dependencies. Generated; change the specs, not this.',
    'const __modules = new Map();',
    'const __loaded = new Map();',
    'const __define = (path, make) => { __modules.set(path, make); };',
    'const __load = (path) => { if (!__loaded.has(path)) __loaded.set(path, __modules.get(path)()); return __loaded.get(path); };',
    ...order.map((path) => wrapped.get(path)!),
    ...Object.entries(ENTRIES).map(([path, list]) => `const { ${list.join(', ')} } = __load(${JSON.stringify(path)});`),
    `export { ${names.join(', ')} };`,
    '',
  ].join('\n')
}

// ---------------------------------------------------------------- the files beside it

const CLI = `#!/usr/bin/env node
// Reruns this paper's simulations with the engine that produced its numbers. Needs Node 18 or
// later and nothing else; node simulate.mjs --help shows how to use it.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from './engine.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const given = args.filter((a) => !a.startsWith('-'))
const files = given.length ? given : readdirSync(join(here, 'specs')).filter((f) => f.endsWith('.json')).sort().map((f) => join(here, 'specs', f))
const missing = files.filter((f) => !existsSync(f))
if (missing.length) {
  console.log('No such file: ' + missing.join(', '))
  process.exit(1)
}
const read = (file) => readFileSync(file, 'utf8')
const expected = join(here, 'expected')
process.exitCode = main(args.filter((a) => a.startsWith('-')), {
  specs: files.map((file) => ({ name: basename(file), text: read(file) })),
  expected: (name) => (existsSync(join(expected, name)) ? read(join(expected, name)) : null),
  // Run whole, the package checks every simulation it publishes, so a spec that went missing fails.
  published: given.length || !existsSync(expected) ? undefined : readdirSync(expected).filter((f) => f.endsWith('.json')),
  print: (line) => console.log(line),
})
`

const STYLE = `
:root { color-scheme: light dark; --bg: #f8f7f4; --card: #ffffff; --fg: #1c1b19; --muted: #66625b; --line: #e3dfd7; --soft: #f0ede6; --good: #1d7442; --bad: #b42318; --changed: #8a5300; }
@media (prefers-color-scheme: dark) { :root { --bg: #151412; --card: #1d1c19; --fg: #ebe9e4; --muted: #a39f97; --line: #35322d; --soft: #26241f; --good: #6fc58f; --bad: #f3897e; --changed: #e2b35e; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 36px 16px 72px; }
h1 { font-size: 1.55rem; line-height: 1.25; margin: 0 0 8px; }
.lead { color: var(--muted); margin: 0 0 28px; max-width: 70ch; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin: 0 0 20px; }
h2 { font-size: 1.15rem; margin: 0 0 6px; }
section > p { margin: 0 0 12px; max-width: 75ch; }
.inputs { display: grid; gap: 10px; margin: 14px 0; }
label { display: grid; grid-template-columns: minmax(80px, 180px) minmax(0, 1fr); gap: 2px 12px; align-items: center; }
label small { grid-column: 2; color: var(--muted); font-size: 0.85rem; }
@media (max-width: 560px) { label { grid-template-columns: minmax(0, 1fr); } label small { grid-column: 1; } }
.name, code, input, textarea, .num { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88rem; }
input, textarea { width: 100%; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
textarea { margin-top: 8px; resize: vertical; }
summary { cursor: pointer; color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 6px; }
button { font: inherit; font-size: 0.95rem; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--soft); color: var(--fg); cursor: pointer; }
button.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.status { font-weight: 600; margin: 10px 0; }
.good { color: var(--good); } .bad { color: var(--bad); } .changed { color: var(--changed); }
.results { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-family: inherit; font-size: inherit; }
.num { text-align: right; white-space: nowrap; }
tr.differs td { color: var(--bad); }
.problems { margin: 0; padding-left: 20px; }
`

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** One page with the engine and the data inline: a browser opens it from disk, with no server and no network. */
function page(engine: string, data: PageData): string {
  // Inside a script element, only </script and <!-- end or alter it; both mean the same to JavaScript when escaped.
  const code = engine.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main id="app"></main>
<script type="module">
${code}
mount(document.getElementById('app'), ${json});
</script>
</body>
</html>
`
}

const METHOD_WORDS: Record<string, string> = {
  monte_carlo: 'Monte Carlo',
  correlated: 'correlated Monte Carlo (a Gaussian copula on rank correlations)',
  sequential: 'sequential Monte Carlo (a bootstrap particle filter)',
}

function sizeWords(r: SimulationResult): string {
  const s = r.provenance.size
  const n = (x: number | undefined) => (x ?? 0).toLocaleString('en-US')
  return s.particles ? `${n(s.replicates)} filters of ${n(s.particles)} particles over ${n(s.steps)} steps` : `${n(s.draws)} draws`
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

function describeRun(run: PublishedRun): string {
  const r = run.result
  const spec = r.spec
  const basis = new Map(run.assumptions.map((a) => [a.name, a.basis]))
  const lines = [`## ${run.id}: ${run.title}`, '', run.purpose, '', `- Method: ${METHOD_WORDS[r.method] ?? r.method}, ${sizeWords(r)}, seed ${r.provenance.seed}.`]
  if (spec.inputs.length) {
    lines.push('- Inputs:')
    for (const i of spec.inputs) {
      const drawn = DISTRIBUTIONS.has(/^\s*([A-Za-z_]+)\s*\(/.exec(i.dist)?.[1] ?? '')
      lines.push(`  - \`${i.name} ${drawn ? '~' : '='} ${i.dist}\`${basis.has(i.name) ? `: ${basis.get(i.name)}` : ''}`)
    }
  }
  const others = run.assumptions.filter((a) => !spec.inputs.some((i) => i.name === a.name))
  if (others.length) {
    lines.push('- Other assumptions:')
    for (const a of others) lines.push(`  - ${a.name}: ${a.basis}`)
  }
  if (spec.model.length) {
    lines.push('- Model:')
    for (const m of spec.model) lines.push(`  - \`${m.name} = ${m.expr}\``)
  }
  if (spec.correlations.length) lines.push(`- Rank correlations: ${spec.correlations.map((c) => `\`${c.a}\` and \`${c.b}\` ${c.rho}`).join('; ')}.`)
  if (spec.sequential) {
    lines.push('- States, updated in this order at each step:')
    for (const s of spec.sequential.states) lines.push(`  - \`${s.name}\`: starts at \`${s.init}\`, then \`${s.next}\``)
    for (const o of spec.sequential.observations) lines.push(`- Observed: \`${o.name}\`, ${o.values.length} values, each distributed as \`${o.likelihood}\``)
  }
  if (spec.events.length) lines.push(`- Events: ${spec.events.map((e) => `\`${e.name}\` when \`${e.when}\``).join('; ')}.`)
  const failed = r.provenance.checks.filter((c) => !c.ok)
  lines.push(`- Checks of the run: ${failed.length ? failed.map((c) => `${c.name}: ${c.detail}`).join('; ') : 'all passed'}.`)
  lines.push('', 'The numbers the paper can cite from it:', '', '| Placeholder | Value | Meaning |', '| --- | --- | --- |')
  for (const c of citable(r)) lines.push(`| \`{{${c.key}}}\` | ${cell(c.value)} | ${cell(c.meaning)} |`)
  return lines.join('\n')
}

function galleyVersion(): string | null {
  try {
    return (JSON.parse(readFileSync(join(ROOT, '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

function readme(runs: PublishedRun[], title: string, check: { ok: boolean; output: string }, engine: string): string {
  const ran = [...new Set(runs.map((r) => r.result.provenance.runtime ?? 'not recorded'))].join(', ')
  const version = galleyVersion()
  const fence = '```'
  return [
    `# ${title}`,
    '',
    'This folder reruns the simulations behind the paper with the engine that produced its numbers. It needs Node.js 18 or later and nothing else: nothing to install, no network.',
    '',
    `${fence}sh`,
    'node simulate.mjs --verify',
    fence,
    '',
    'reruns every simulation and checks each number against what the paper cites, at the precision the paper cites it. It prints every difference and exits with status 1 if there is one, and with 0 when every number matches.',
    '',
    `${fence}sh`,
    'node simulate.mjs                  # every simulation: each number under its placeholder key',
    'node simulate.mjs specs/S1.json    # one simulation, as published or after you change it',
    'node simulate.mjs --json           # the numbers as JSON',
    fence,
    '',
    'Or open `index.html` in a browser. It runs the same engine, compares every number with the paper, and lets you change an input and run again.',
    '',
    check.ok
      ? 'When galley wrote this package it ran the verification itself, and every number matched.'
      : `When galley wrote this package it ran the verification itself, and it did not pass:\n\n${fence}\n${check.output}\n${fence}`,
    '',
    ...runs.flatMap((run) => [describeRun(run), '']),
    '## What ran',
    '',
    `- Engine: \`${ENGINE}\`${version ? `, from galley ${version}` : ''}, in \`engine.mjs\` (fingerprint \`${fingerprint(engine)}\`).`,
    `- JavaScript: the paper's runs used ${ran}; this package was written with node ${process.version}. The same spec and seed give the same numbers on the same JavaScript engine. Across engines \`Math.exp\` and \`Math.log\` may differ in the last digit, which the check at the cited precision absorbs.`,
    '- `specs/`: each simulation\'s spec, with its seed. `SPEC.md` describes the format, for changing one.',
    '- `expected/`: every number the paper can cite from each simulation, as the text shows it.',
    '- `simulate.mjs`: the command. `engine.mjs`: the engine. `index.html`: the same in a browser.',
    '',
  ].join('\n')
}

/** Reruns the package's own verification with Node, as a reader would. */
export function verifyReproduction(dir: string): { ok: boolean; output: string } {
  const run = spawnSync(process.execPath, [join(dir, 'simulate.mjs'), '--verify'], { encoding: 'utf8', timeout: 600_000 })
  return { ok: run.status === 0, output: [run.stdout, run.stderr, run.error ? String(run.error) : ''].filter(Boolean).join('\n').trim() }
}

/** The files of a package besides its specs and expected numbers. */
const FILES = ['engine.mjs', 'simulate.mjs', 'index.html', 'README.md', 'SPEC.md']

export interface ReproductionOptions {
  /** The paper's title, for the README and the page. */
  title?: string
  /** Told how the package's own verification went, as a caller may want to note a failure. */
  verified?: (check: { ok: boolean; output: string }) => void
}

/**
 * Writes the reproduction package for a paper's simulations into dir, and returns the files it
 * wrote. It verifies the package as a reader would and says in the README how that went; a failure
 * is reported there and to `verified`, never thrown. With no runs it removes what an earlier package
 * left, so a paper that dropped its simulations publishes none.
 */
export function writeReproduction(dir: string, runs: PublishedRun[], options: ReproductionOptions = {}): string[] {
  // Only what a package writes is cleared, so a simulation the paper dropped leaves nothing behind.
  for (const sub of ['specs', 'expected']) {
    const folder = join(dir, sub)
    if (!existsSync(folder)) continue
    for (const name of readdirSync(folder)) if (name.endsWith('.json')) rmSync(join(folder, name))
    if (!runs.length && !readdirSync(folder).length) rmSync(folder, { recursive: true })
  }
  if (!runs.length) {
    for (const name of FILES) rmSync(join(dir, name), { force: true })
    if (existsSync(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true })
    return []
  }
  const title = options.title ? `Reproducing the simulations of “${options.title}”` : 'Reproducing the simulations'
  const written: string[] = []
  const write = (path: string, text: string) => {
    const file = join(dir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    written.push(file)
  }
  const engine = bundleEngine()
  write('engine.mjs', engine)
  write('simulate.mjs', CLI)
  for (const run of runs) {
    write(`specs/${run.id}.json`, `${JSON.stringify(run.result.spec, null, 2)}\n`)
    write(`expected/${run.id}.json`, `${JSON.stringify(expectedOf(run.result), null, 2)}\n`)
  }
  write('SPEC.md', `# The spec format\n\n${specGuide()}\n`)
  write('index.html', page(engine, {
    title,
    runs: runs.map((run) => ({ id: run.id, title: run.title, purpose: run.purpose, assumptions: run.assumptions, spec: run.result.spec, expected: expectedOf(run.result) })),
  }))
  const check = verifyReproduction(dir)
  options.verified?.(check)
  write('README.md', readme(runs, title, check, engine))
  return written
}
