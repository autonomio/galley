#!/usr/bin/env node
// galley: a seed in, a pre-publication manuscript out.
//
//   galley write <seed.md> [dir]     start a paper from a seed and run it to the end
//   galley new <dir> <seed.md>       start a paper without running it
//   galley run <dir> [--until id]    run (or resume) a paper; picks up notes you wrote in the editor
//   galley status <dir>              where a paper stands
//   galley papers [root]             every paper under papers/ (or root), one line each
//   galley choices <dir>             citation choices waiting for you ("for this claim choose a, b or c")
//   galley choose <dir> <claim> <a,b|auto|none>   answer one
//   galley open <dir>                how to open the manuscript in the editor
//   galley typeset <dir>             render the outputs again from the paper as it stands (no model calls)
//   galley ladder                    the behaviors, in ladder order
//   galley doctor                    check that every model, tool and source answers
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { LADDER } from './behaviors/index.js'
import { answerChoice } from './behaviors/truth.js'
import { FAMILY_MODELS } from './config.js'
import { budgetLine, canaryPython, canarySearch, openalexBudget, openalexKeyed, SEARCH_CREDITS } from './evidence.js'
import { callModel, codexBin } from './models.js'
import { Paper } from './paper.js'
import { importEditorEdits, importHumanNotes, importProposalDecisions, productionRecord, typeset } from './render.js'
import { runPaper, Stalled } from './scheduler.js'
import { obj, bool } from './schema.js'
import { DOES } from './self.js'
import type { Family } from './types.js'

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

function positional(): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue }
    out.push(args[i])
  }
  return out
}

function slugFromSeed(seed: string, file: string): string {
  const base = basename(file).replace(/\.[^.]+$/, '')
  if (base && base !== 'seed') return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return seed.split(/\s+/).slice(0, 5).join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 40) || 'paper'
}

function status(paper: Paper): void {
  const s = paper.state
  const active = s.claims.filter((c) => c.status !== 'dropped')
  const count = (status: string) => active.filter((c) => c.status === status).length
  const done = Object.values(s.settled).filter((v) => v === 'done').length
  const skipped = Object.values(s.settled).filter((v) => v === 'skipped').length
  console.log(`${s.slug}: ${s.outcome ?? 'in progress'}`)
  console.log(`  title    ${paper.config.title || s.frame?.title || s.plan?.workingTitle || '(not yet)'}`)
  if (s.ideaReview) console.log(`  idea     ${s.ideaReview.verdict}, weakest ${s.ideaReview.weakest}`)
  console.log(`  claims   ${active.length}: ${count('supported')} supported, ${count('narrowed')} narrowed, ${count('internal')} own work, ${count('assumed')} premises, ${count('unsupported')} hypotheses, ${count('open')} open`)
  console.log(`  evidence ${Object.keys(s.works).length} works screened, ${s.citations.filter((c) => c.status === 'verified').length} citations verified, ${s.citations.filter((c) => c.status === 'rejected').length} rejected`)
  console.log(`  sections ${Object.keys(s.passages).length}/${s.outline?.sections.length ?? '?'} drafted; referee round ${s.round}; findings ${s.findings.length} (${s.findings.filter((f) => f.status === 'open').length} open)`)
  console.log(`  steps    ${done} done, ${skipped} skipped`)
  const record = productionRecord(paper)
  console.log(`  cost     ${record['run.calls']} calls, ${record['run.tokens_in_m']}M tokens in, ${record['run.hours']} h`)
  // What a running process is doing right now, from the progress file it keeps.
  const progressFile = paper.path('progress.json')
  if (existsSync(progressFile)) {
    const progress = JSON.parse(readFileSync(progressFile, 'utf8'))
    let alive = false
    try { process.kill(progress.pid, 0); alive = true } catch { /* not running */ }
    if (alive && progress.inFlight?.length) {
      console.log('  running now:')
      for (const f of progress.inFlight) {
        const seconds = Math.round((Date.now() - Date.parse(f.started)) / 1000)
        console.log(`    ${f.behavior} ${f.target}: ${f.what}, ${seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`}`)
      }
    } else if (!alive && !s.outcome) console.log('  running now: nothing (resume with galley run)')
  }
  if (existsSync(paper.path('out', 'paper.pdf'))) console.log(`  pdf      ${paper.path('out', 'paper.pdf')}`)
}

async function run(dir: string): Promise<void> {
  const paper = Paper.open(dir)
  const decided = importProposalDecisions(paper)
  if (decided) console.log(`${decided} proposal decision(s) from the editor recorded.`)
  const edited = importEditorEdits(paper)
  if (edited.length) console.log(`Your edits in the editor are now the paper's text: ${edited.join(', ')}.`)
  const added = importHumanNotes(paper)
  if (added) console.log(`${added} note(s) from the editor became threads for the agents.`)
  if (!paper.config.off.includes('find-evidence') && !openalexKeyed()) {
    // Said up front, so a short budget is never discovered as a skipped search hours later.
    const budget = await openalexBudget()
    if (budget) console.log(budgetLine(budget))
  }
  const started = Date.now()
  try {
    const outcome = await runPaper(paper, LADDER, { until: flag('until') })
    console.log(`\n${outcome ? `Outcome: ${outcome}` : 'Stopped'} after ${Math.round((Date.now() - started) / 60000)} min.`)
  } catch (error) {
    if (error instanceof Stalled) {
      console.error(`\nPaused: ${error.message}\nRun the same command again to resume.`)
      process.exitCode = 2
    } else throw error
  }
  status(Paper.open(dir))
}

async function doctor(): Promise<void> {
  const check = async (name: string, fn: () => Promise<string>) => {
    try { console.log(`ok   ${name}: ${await fn()}`) } catch (error) { console.log(`FAIL ${name}: ${(error as Error).message.split('\n')[0].slice(0, 300)}`); process.exitCode = 1 }
  }
  const tiny = obj({ ok: bool() })
  for (const family of ['claude', 'gpt', 'gemini'] as Family[]) {
    const { model, effort } = FAMILY_MODELS[family]
    await check(`${family} (${model})`, async () => {
      const result = await callModel({ spec: { family, model, effort: family === 'gemini' ? effort : 'low' }, prompt: 'Reply with the JSON object {"ok": true}.', schema: tiny, timeoutMs: 300_000 })
      return `answered in ${Math.round(result.ms / 1000)}s`
    })
  }
  await check('codex binary', async () => `${codexBin()} (${execFileSync(codexBin(), ['--version']).toString().trim()})`)
  await check('pandoc', async () => execFileSync('pandoc', ['--version']).toString().split('\n')[0])
  await check('typst', async () => execFileSync('typst', ['--version']).toString().trim())
  await check('canary runtime', async () => existsSync(canaryPython()) ? canaryPython() : Promise.reject(new Error('not installed')))
  await check('openalex budget', async () => {
    if (openalexKeyed()) return 'API key configured'
    const budget = await openalexBudget()
    if (!budget) return 'no API key; the budget could not be read'
    if (budget.remaining < SEARCH_CREDITS) throw new Error(budgetLine(budget))
    return budgetLine(budget)
  })
  await check('openalex via canary', async () => {
    const tmp = `/tmp/galley-doctor-${process.pid}`
    const r = await canarySearch(tmp, 'galley:doctor', [{ id: 'q1', search: 'citation impact novelty' }], 3, undefined, 60_000)
    return `${r.q1.results.length} results (matched ${r.q1.matched})`
  })
}

async function main(): Promise<void> {
  switch (command) {
    case 'write':
    case 'new': {
      const [a, b] = positional()
      const seedFile = command === 'write' ? a : b
      if (!seedFile || !existsSync(seedFile)) throw new Error(`usage: galley ${command === 'write' ? 'write <seed.md> [dir]' : 'new <dir> <seed.md>'}`)
      const seed = readFileSync(seedFile, 'utf8')
      const dir = resolve(command === 'write' ? (b ?? `papers/${slugFromSeed(seed, seedFile)}`) : a)
      const author = flag('author')
      Paper.create(dir, seed, {
        ...(author ? { authors: [{ name: author, ...(flag('affiliation') ? { affiliation: flag('affiliation') } : {}) }] } : {}),
        ...(flag('venue') ? { venue: flag('venue')! } : {}),
        ...(flag('words') ? { words: Number(flag('words')) } : {}),
        ...(flag('editor') ? { editorDir: resolve(flag('editor')!) } : {}),
        ...(flag('citations') ? { citations: flag('citations') as 'auto' | 'choose' | 'mixed' } : {}),
        ...(flag('dial') ? { dial: flag('dial') as 'autonomous' | 'assisted' | 'propose' } : {}),
      })
      console.log(`Paper created in ${dir}`)
      if (command === 'write') await run(dir)
      return
    }
    case 'run': {
      const [dir] = positional()
      if (!dir) throw new Error('usage: galley run <dir> [--until behavior]')
      await run(resolve(dir))
      return
    }
    case 'status': {
      const [dir] = positional()
      status(Paper.open(resolve(dir)))
      return
    }
    case 'choices': {
      const [dir] = positional()
      const paper = Paper.open(resolve(dir))
      const open = Object.values(paper.state.choices ?? {}).filter((c) => !c.answered)
      if (!open.length) { console.log('No citation choices are waiting.'); return }
      for (const choice of open) {
        console.log(`\n${choice.claimId}: ${paper.state.claims.find((c) => c.id === choice.claimId)?.text}`)
        for (const o of choice.options) {
          const w = paper.state.works[o.workId]
          console.log(`  ${o.letter}) ${w.authors.slice(0, 2).join(', ')}${w.authors.length > 2 ? ' et al.' : ''} (${w.year ?? 'n.d.'}), ${w.title} [${o.fit}, ${o.role}]\n     "${o.passage}"`)
        }
      }
      console.log(`\nAnswer with: galley choose ${dir} <claim> <letters | auto | none>`)
      return
    }
    case 'choose': {
      const [dir, claimId, answer] = positional()
      if (!answer) throw new Error('usage: galley choose <dir> <claim> <a,b | auto | none>')
      console.log(answerChoice(Paper.open(resolve(dir)), claimId, answer))
      return
    }
    case 'papers': {
      const root = resolve(positional()[0] ?? 'papers')
      if (!existsSync(root)) { console.log(`No papers in ${root}.`); return }
      for (const name of readdirSync(root).sort()) {
        const dir = resolve(root, name)
        if (!existsSync(resolve(dir, 'state.json'))) continue
        const paper = Paper.open(dir)
        const s = paper.state
        let running = ''
        try {
          const progress = JSON.parse(readFileSync(paper.path('progress.json'), 'utf8'))
          process.kill(progress.pid, 0)
          running = progress.inFlight?.length ? `running: ${progress.inFlight.map((f: { behavior: string }) => f.behavior).join(', ')}` : 'running'
        } catch { /* not running */ }
        const stage = s.outcome ?? (running || `paused after ${Object.keys(s.settled).length} steps`)
        console.log(`${name.padEnd(28)} ${String(stage).padEnd(36)} ${paper.config.title || s.frame?.title || s.plan?.workingTitle || ''}`)
      }
      return
    }
    case 'typeset': {
      const [dir] = positional()
      const paper = Paper.open(resolve(dir))
      console.log(`Made ${(await typeset(paper)).join(', ')} in ${paper.path('out')}`)
      return
    }
    case 'open': {
      const [dir] = positional()
      const paper = Paper.open(resolve(dir))
      const editor = paper.config.editorDir || paper.path('editor')
      console.log(`The manuscript and its notes are in ${editor}. Open them in the editor with:\n\n  GALLEY_DIR=${editor} npm run dev\n\nthen visit http://localhost:5174. Your edits and notes go back into the paper on the next "galley run ${dir}".`)
      return
    }
    case 'ladder':
      for (const [i, b] of LADDER.entries()) console.log(`${String(i + 1).padStart(2)} ${b.id.padEnd(20)} ${b.stage.padEnd(10)} ${b.improver ? 'improver' : 'required'}  ${DOES[b.id] ?? b.title}`)
      return
    case 'doctor':
      await doctor()
      return
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
