#!/usr/bin/env node
// galley: a seed in, a pre-publication manuscript out.
//
//   galley write <seed.md> [dir]     start a paper from a seed and run it to the end
//       --mode thesis --stance <extend|contest|reframe>   formulate a thesis instead, handed back as a brief
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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { LADDER } from './behaviors/index.js'
import { answerChoice } from './behaviors/truth.js'
import { applyFamilies, defaultConfig, FAMILIES, familiesOn, FAMILY_MODELS, FAMILY_NAMES } from './config.js'
import { budgetLine, canaryPython, canarySearch, openalexBudget, openalexKeyed, SEARCH_CREDITS } from './evidence.js'
import { callModel, codexBin, resetHintMs } from './models.js'
import { Paper } from './paper.js'
import { editorDir, productionRecord, syncEditor, typeset } from './render.js'
import { runPaper, Stalled } from './scheduler.js'
import { obj, bool } from './schema.js'
import { DOES } from './self.js'
import { addDatabase, addDatasets, addMaterials, type DatasetManifest } from './materials.js'
import { discover, parseConnectionLine, publicConnection, readConnections, type DatabaseSpec } from './databases.js'
import { datasetFromRecord, isDatasetRecord, readRecord } from './records.js'
import { keepWorldModel, loadWorldModelFile, worldModelName, worldModelSummary } from './worldmodel.js'
import { reviewDone } from './behaviors/close.js'
import { REVIEW_SETTINGS } from './literature.js'
import type { Family } from './types.js'

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

/** Every value of a flag that may repeat. */
function flags(name: string): string[] {
  return args.flatMap((a, i) => a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1]] : [])
}

/** yes adds an option in support, load-bearing makes it what the paper's contribution rests on. */
function option(value: string | undefined): true | 'load-bearing' | undefined {
  if (!value) return undefined
  if (/^load[-_ ]?bearing$|^main$|^central$/i.test(value)) return 'load-bearing'
  return /^(yes|true|on|systematic)$/i.test(value) ? true : undefined
}

/** Model families as a list (claude,gpt,gemini): at least two, so one writes and another checks. */
function modelsFlag(value: string): Family[] {
  const families = [...new Set(value.split(/[,\s]+/).map((v) => v.trim().toLowerCase()).filter(Boolean))] as Family[]
  const unknown = families.filter((f) => !FAMILIES.includes(f))
  if (unknown.length) throw new Error(`unknown model families: ${unknown.join(', ')} (choose from ${FAMILIES.join(', ')})`)
  if (families.length < 2) throw new Error('choose at least two model families: one writes, another checks')
  return families
}

/** A database manifest, read once: one that carries a password is removed as soon as it is read; the password goes to the connections file only. */
function readDatabaseManifest(path: string): DatabaseSpec {
  const spec = JSON.parse(readFileSync(path, 'utf8')) as DatabaseSpec
  const lined = spec.line ? parseConnectionLine(spec.line) : null
  if (spec.password || (lined?.via === 'http' && lined.password)) rmSync(path, { force: true })
  return spec
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

/** What each behavior is doing, in words a person reads in the status view. */
const DOING: Record<string, string> = {
  extract: 'Reading the seed', position: 'Searching the literature for prior art', 'review-idea': 'Reviewing the idea on seven factors', 'literature-review': 'Literature review (Canary)', simulate: 'Designing and running the simulation',
  reformulate: 'Writing three directions', 'select-direction': 'Choosing a direction', 'analysis-plan': 'Planning the analysis of your data', 'analysis-review': 'A statistician reviewing the analysis plan', 'extract-data': 'Extracting from the database', analyze: 'Running the analyses of your data', plan: 'Planning the argument',
  outline: 'Outlining', 'find-evidence': 'Finding evidence', verify: 'Verifying citations', reassess: 'Reassessing the thesis', calibrate: 'Calibrating the verifier',
  draft: 'Drafting', figure: 'Drawing figures', fidelity: 'Checking sections against their claims', frame: 'Writing the title and abstract',
  referee: 'Referee review', 'close-round': 'Closing the round', respond: 'Answering the referees', 'verify-disposition': 'Referees judging the answers',
  adjudicate: 'Settling disputes', 'handle-finding': 'Stating an unsettled finding as a limitation', reconcile: 'Reconciling the ledger with the text', reprofile: 'Profiling the finished paper', typeset: 'Typesetting',
  proof: 'Reading the typeset paper', 'web-sources': 'Finding primary sources on the web',
  formulate: 'Formulating the thesis', 'test-thesis': 'Testing the thesis against the literature', 'thesis-brief': 'Writing the thesis brief',
}

/** Where a paper stands, as structured data for a host to show. */
function statusData(paper: Paper): Record<string, unknown> {
  const s = paper.state
  const active = s.claims.filter((c) => c.status !== 'dropped')
  const count = (status: string) => active.filter((c) => c.status === status).length
  const record = productionRecord(paper)
  const datasets = (paper.config.materials ?? []).some((m) => m.kind === 'dataset')
  const evidenceDone = !!s.outline && !s.citations.some((c) => c.status === 'selected') && !active.some((c) => c.need === 'external' && c.status === 'open')
  const stages: [string, string, boolean][] = paper.config.mode === 'thesis' ? [
    ['seed', 'Seed', !!s.brief],
    ['aim', 'Place the idea', paper.isSettled('position:seed')],
    ['literature', 'Literature', !paper.config.literatureReview || paper.config.off.includes('literature-review') || (!!s.literature && s.literature.status !== 'running')],
    ['thesis', 'Thesis', !!s.thesis],
    ['test', 'Test', !!s.thesis?.test || paper.config.off.includes('test-thesis')],
    ['brief', 'Brief', s.outcome === 'thesis_ready'],
  ] : [
    ['seed', 'Seed', !!s.brief],
    ['aim', 'Aim', !!s.plan || !!s.selectedDirection || s.ideaReview?.verdict === 'worth_writing'],
    ...(datasets ? [['data', 'Data', !!s.measurements] as [string, string, boolean]] : []),
    ...(paper.config.simulation ? [['simulation', 'Simulation', !!s.simulations] as [string, string, boolean]] : []),
    ['plan', 'Plan', !!s.outline],
    ['evidence', 'Evidence', evidenceDone],
    ...(paper.config.literatureReview ? [['literature', 'Literature', s.literature?.status === 'done' || s.literature?.status === 'failed'] as [string, string, boolean]] : []),
    ['draft', 'Draft', !!s.frame],
    ['review', 'Review', !!s.frame && reviewDone(paper)],
    ['finish', 'Finish', s.outcome === 'ready_for_submission'],
  ]
  let running = false
  let now: { doing: string; who: string; seconds: number }[] = []
  const progressFile = paper.path('progress.json')
  if (existsSync(progressFile)) {
    const progress = JSON.parse(readFileSync(progressFile, 'utf8'))
    try { process.kill(progress.pid, 0); running = !progress.outcome } catch { /* not running */ }
    if (running) now = (progress.inFlight ?? []).map((f: { behavior: string; what: string; started: string }) => ({ doing: DOING[f.behavior] ?? f.behavior, who: f.what, seconds: Math.round((Date.now() - Date.parse(f.started)) / 1000) }))
  }
  // A provider's usage limit being waited out, read from the journal so any run, old or new, reports it.
  let waiting: { family: string; name: string; seconds: number; resetsIn: number | null } | null = null
  if (running && existsSync(paper.path('journal.jsonl'))) {
    const lines = readFileSync(paper.path('journal.jsonl'), 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 400); i--) {
      const e = JSON.parse(lines[i])
      if (e.event === 'call' || e.event === 'settled') break
      if (e.event !== 'provider_limit') continue
      const left = Math.round((Date.parse(e.at) + e.wait_ms - Date.now()) / 1000)
      const hint = resetHintMs(String(e.message ?? ''))
      const resetsIn = hint === null ? null : Math.max(0, Math.round((Date.parse(e.at) + hint - Date.now()) / 1000))
      if (left > 0) waiting = { family: e.family, name: FAMILY_NAMES[e.family as Family] ?? e.family, seconds: left, resetsIn }
      break
    }
  }
  const firstLine = s.seed.text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? ''
  return {
    slug: s.slug,
    title: titleOf(paper),
    seedTitle: firstLine.slice(0, 120),
    mode: paper.config.mode ?? 'paper',
    ...(paper.config.mode === 'thesis' ? { stance: paper.config.stance ?? 'extend', thesis: s.thesis ? { statement: s.thesis.statement, passes: s.thesis.test?.passes ?? null, searched: s.thesis.test?.searched, testOff: paper.config.off.includes('test-thesis') } : null } : {}),
    outcome: s.outcome ?? null,
    running,
    startedAt: s.createdAt,
    stages: stages.map(([id, label, done]) => ({ id, label, done })),
    now,
    waiting,
    claims: { total: active.length, supported: count('supported'), narrowed: count('narrowed'), own: count('internal'), premises: count('assumed'), hypotheses: count('unsupported'), open: count('open') },
    evidence: { screened: Object.keys(s.works).length, verified: s.citations.filter((c) => c.status === 'verified').length, rejected: s.citations.filter((c) => c.status === 'rejected').length },
    sections: { drafted: Object.keys(s.passages).length, total: s.outline?.sections.length ?? null },
    review: { round: s.round, rounds: paper.config.rounds, findings: s.findings.length, open: s.findings.filter((f) => f.status === 'open').length },
    cost: { calls: record['run.calls'], tokensInM: record['run.tokens_in_m'], hours: record['run.hours'] },
    typeset: existsSync(paper.path('out', paper.config.mode === 'thesis' ? 'thesis.pdf' : 'paper.pdf')),
    // What the project was started with, shown in its settings: the seed is kept here once the document becomes the paper.
    seed: s.seed.text,
    settings: {
      literatureReview: paper.config.literatureReview ?? false, simulation: paper.config.simulation ?? false,
      rounds: paper.config.rounds, words: paper.config.words, venue: paper.config.venue,
      authors: paper.config.authors.map((a) => a.affiliation ? `${a.name}, ${a.affiliation}` : a.name),
      materials: (paper.config.materials ?? []).map((m) => `${m.name}${m.kind === 'dataset' ? (m.private ? ' (private dataset)' : ' (shared dataset)') : m.kind === 'link' ? ' (link)' : ''}`),
      // The model families the paper may use, and who sits where for them; a change takes effect at the next step.
      families: familiesOn(paper.config),
      seats: Object.fromEntries(Object.entries(paper.config.seats).map(([seat, family]) => [seat, FAMILY_NAMES[family]])),
    },
  }
}

/** The run's title so far: the one the person gave, else the thesis's own, or the paper's. */
function titleOf(paper: Paper): string | null {
  const s = paper.state
  return paper.config.title || (paper.config.mode === 'thesis' ? s.thesis?.title : s.frame?.title || s.plan?.workingTitle) || null
}

function status(paper: Paper): void {
  const s = paper.state
  const active = s.claims.filter((c) => c.status !== 'dropped')
  const count = (status: string) => active.filter((c) => c.status === status).length
  const done = Object.values(s.settled).filter((v) => v === 'done').length
  const skipped = Object.values(s.settled).filter((v) => v === 'skipped').length
  const thesis = paper.config.mode === 'thesis'
  console.log(`${s.slug}: ${s.outcome ?? 'in progress'}`)
  console.log(`  title    ${titleOf(paper) ?? '(not yet)'}`)
  if (thesis) {
    const test = s.thesis?.test
    console.log(`  thesis   ${s.thesis ? s.thesis.statement : '(not yet)'} [${paper.config.stance ?? 'extend'}${test ? `; ${test.passes ? 'meets its test' : 'does not yet meet its test'}${test.searched === null ? ', without a novelty search' : ''}` : paper.config.off.includes('test-thesis') ? '; not tested: the test is off' : ''}]`)
    if (existsSync(paper.path('out', 'thesis.md'))) console.log(`  brief    ${paper.path('out', 'thesis.md')}`)
  } else {
    if (s.ideaReview) console.log(`  idea     ${s.ideaReview.verdict}, weakest ${s.ideaReview.weakest}`)
    console.log(`  claims   ${active.length}: ${count('supported')} supported, ${count('narrowed')} narrowed, ${count('internal')} own work, ${count('assumed')} premises, ${count('unsupported')} hypotheses, ${count('open')} open`)
    console.log(`  evidence ${Object.keys(s.works).length} works screened, ${s.citations.filter((c) => c.status === 'verified').length} citations verified, ${s.citations.filter((c) => c.status === 'rejected').length} rejected`)
    console.log(`  sections ${Object.keys(s.passages).length}/${s.outline?.sections.length ?? '?'} drafted; referee round ${s.round}; findings ${s.findings.length} (${s.findings.filter((f) => f.status === 'open').length} open)`)
  }
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
  const pdf = paper.path('out', thesis ? 'thesis.pdf' : 'paper.pdf')
  if (existsSync(pdf)) console.log(`  pdf      ${pdf}`)
}

async function run(dir: string): Promise<void> {
  const paper = Paper.open(dir)
  // The paper lives in the editor from its first step: what a person did there is taken in, and the editor's copy is written now and kept in step.
  const taken = syncEditor(paper)
  if (taken.decisions) console.log(`${taken.decisions} proposal decision(s) from the editor recorded.`)
  if (taken.edits.length) console.log(`Your edits in the editor are now the paper's text: ${taken.edits.join(', ')}.`)
  if (taken.notes) console.log(`${taken.notes} note(s) and replies from the editor became threads for the agents.`)
  if (!paper.config.off.includes('find-evidence') && !openalexKeyed()) {
    // Said up front, so a short budget is never discovered as a skipped search hours later.
    const budget = await openalexBudget()
    if (budget) console.log(budgetLine(budget))
  }
  const started = Date.now()
  try {
    const outcome = await runPaper(paper, LADDER, { until: flag('until'), sync: syncEditor })
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
      // The authors' own materials: datasets stay private unless named shared.
      const sources = [...flags('material').map((source) => ({ source })), ...flags('shared-material').map((source) => ({ source, shared: true }))]
      const loose = sources.length ? await addMaterials(dir, sources) : []
      // A dataset as a unit: a manifest names its files (relative to the manifest) and says where the data comes from.
      // A dataset is given by its link (a Zenodo record or its DOI), or by a manifest that names its files or its record.
      const manifests: DatasetManifest[] = []
      for (const value of flags('dataset')) {
        const inbox = () => mkdtempSync(join(tmpdir(), 'galley-record-'))
        if (isDatasetRecord(value)) { manifests.push(await datasetFromRecord(value, inbox())); continue }
        const manifest = JSON.parse(readFileSync(value, 'utf8')) as DatasetManifest & { record?: string }
        if (manifest.record) {
          const { record, files: _files, ...given } = manifest
          manifests.push(await datasetFromRecord(record, inbox(), Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined && v !== ''))))
          continue
        }
        manifests.push({ ...manifest, files: (manifest.files ?? []).map((file) => resolve(dirname(resolve(value)), file)) })
      }
      const units = manifests.length ? await addDatasets(dir, manifests, loose.length) : { materials: [], datasets: [] }
      // A database: a saved connection's name, user@server#database or clickhouse://…#database, or a manifest naming one.
      for (const value of flags('database')) {
        const saved = readConnections().find((c) => c.name === value)
        const spec: DatabaseSpec = saved ? { connection: saved.name, database: saved.database }
          : /#[\w-]+$/.test(value) ? { line: value.replace(/#[\w-]+$/, ''), database: value.match(/#([\w-]+)$/)![1] }
            : readDatabaseManifest(value)
        units.datasets.push(await addDatabase(dir, spec, `D${units.datasets.length + 1}`))
      }
      // A world model the sources come from: a Resolvent repository as a zip or a folder, or the file galley read it into.
      // Only its sources, unless --other-sources yes.
      const worldModelPath = flag('world-model')
      const onlySources = !/^(yes|on|true)$/i.test(flag('other-sources') ?? '')
      const worldModel = worldModelPath ? keepWorldModel(dir, await loadWorldModelFile(resolve(worldModelPath)), onlySources) : undefined
      if (worldModel) console.log(`World model: "${worldModel.name}", ${worldModel.claims} claims, ${worldModel.sources} sources; ${worldModel.only ? 'its sources only' : 'its sources first, then the literature and the web'}`)
      if (worldModel?.only && option(flag('literature-review')) !== undefined) console.log('No literature review: the paper rests only on its world model (give --other-sources yes to add one).')
      const materials = [...loose, ...units.materials]
      for (const m of materials) console.log(`Material ${m.id}: ${m.kind} ${m.url ?? m.name}${m.dataset ? ` in ${m.dataset}` : ''}${m.kind === 'dataset' ? (m.private ? ' (private)' : ' (shared)') : m.text ? '' : ' (its text could not be read)'}`)
      for (const u of units.datasets) console.log(`Dataset ${u.id}: ${u.name}, produced by ${u.producedBy}${u.doi ? `, DOI ${u.doi}` : u.url ? `, ${u.url}` : ''}${u.describedIn ? `, first reported in ${u.describedIn}` : ''}`)
      // A thesis is formulated from the literature: its run always has the review, and no simulation.
      const mode = flag('mode') === 'thesis' ? 'thesis' as const : undefined
      const stance = flag('stance')
      if (stance && !['extend', 'contest', 'reframe'].includes(stance)) throw new Error('--stance is extend, contest or reframe')
      Paper.create(dir, seed, {
        ...(mode ? { mode, stance: (stance ?? 'extend') as 'extend' | 'contest' | 'reframe', literatureReview: true, simulation: false } : {}),
        ...(materials.length ? { materials } : {}),
        ...(units.datasets.length ? { datasets: units.datasets } : {}),
        ...(flag('rounds') ? { rounds: Math.max(1, Number(flag('rounds'))) } : {}),
        ...(author ? { authors: [{ name: author, ...(flag('affiliation') ? { affiliation: flag('affiliation') } : {}) }] } : {}),
        ...(flag('venue') ? { venue: flag('venue')! } : {}),
        ...(flag('funding') || flag('competing-interests') || flag('acknowledgements') ? { declarations: {
          ...(flag('funding') ? { funding: flag('funding')! } : {}),
          ...(flag('competing-interests') ? { competing_interests: flag('competing-interests')! } : {}),
          ...(flag('acknowledgements') ? { acknowledgements: flag('acknowledgements')! } : {}),
        } } : {}),
        ...(flag('words') ? { words: Number(flag('words')) } : {}),
        ...(flag('editor') ? { editorDir: resolve(flag('editor')!) } : {}),
        ...(flag('editor-doc') ? { editorDoc: flag('editor-doc')! } : {}),
        ...(flag('citations') ? { citations: flag('citations') as 'auto' | 'choose' | 'mixed' } : {}),
        ...(flag('dial') ? { dial: flag('dial') as 'autonomous' | 'assisted' | 'propose' } : {}),
        ...(option(flag('literature-review')) !== undefined ? { literatureReview: option(flag('literature-review')) } : {}),
        ...(option(flag('simulation')) !== undefined ? { simulation: option(flag('simulation')) } : {}),
        ...(/^(no|off|false)$/i.test(flag('web-sources') ?? '') ? { webSources: false } : {}),
        ...(flag('models') ? { families: modelsFlag(flag('models')!) } : {}),
        ...(worldModel ? { worldModel } : {}),
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
      const paper = Paper.open(resolve(dir))
      if (args.includes('--json')) console.log(JSON.stringify(statusData(paper)))
      else status(paper)
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
        console.log(`${name.padEnd(28)} ${String(stage).padEnd(36)} ${titleOf(paper) ?? ''}`)
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
      const editor = editorDir(paper)
      console.log(`The manuscript and its notes are in ${editor}. Open them in the editor with:\n\n  GALLEY_DIR=${editor} npm run dev\n\nthen visit http://localhost:5174. While the paper is being written, your edits, notes and replies are taken in within seconds; otherwise on the next "galley run ${dir}".`)
      return
    }
    case 'db': {
      // With a line (user@server, or a clickhouse:// address): every ClickHouse found there, with its databases. Without: the saved connections, passwords left out.
      // "-" reads the line from stdin, so a line that carries a password never shows in a process listing.
      const [given] = positional()
      const line = given === '-' ? readFileSync(0, 'utf8').trim() : given
      console.log(JSON.stringify(line ? await discover(line) : readConnections().map(publicConnection)))
      return
    }
    case 'world-model': {
      // What a world model holds (a Resolvent repository as a zip or a folder), for a host to show before the paper starts.
      // With --out, its records are kept in that file, which --world-model then takes as it is.
      const [path] = positional()
      if (!path) throw new Error('usage: galley world-model <zip or folder> [--out <file.json>]')
      const model = await loadWorldModelFile(resolve(path), flag('name') ? worldModelName(flag('name')!) : undefined)
      if (flag('out')) writeFileSync(resolve(flag('out')!), JSON.stringify(model))
      console.log(JSON.stringify(worldModelSummary(model)))
      return
    }
    case 'record': {
      // What a dataset's published record says about it (a Zenodo record or its DOI), for a host to show before the paper starts.
      const [link] = positional()
      if (!link) throw new Error('usage: galley record <link>')
      console.log(JSON.stringify(await readRecord(link)))
      return
    }
    case 'context': {
      // What a host shows before a paper starts: who sits where, the defaults, and whether literature search has a key.
      // With --models, the seats as they are dealt for those families.
      const config = applyFamilies({ ...defaultConfig(), ...(flag('models') ? { families: modelsFlag(flag('models')!) } : {}) })
      console.log(JSON.stringify({
        openalexKey: openalexKeyed(),
        families: familiesOn(config).map((family) => ({ family, name: FAMILY_NAMES[family], model: FAMILY_MODELS[family].model })),
        seats: Object.fromEntries(Object.entries(config.seats).map(([seat, family]) => [seat, { family, name: FAMILY_NAMES[family], model: FAMILY_MODELS[family].model }])),
        referees: config.referees.map((r) => r.seat),
        defaults: { venue: config.venue, words: config.words, rounds: config.rounds, dial: config.dial, citations: config.citations, literatureReview: false, simulation: false },
        review: REVIEW_SETTINGS,
      }))
      return
    }
    case 'models': {
      // Which model families a paper may use: written to its paper.json; a running paper deals its seats again at its next step.
      const [dir, list] = positional()
      if (!dir || !list) throw new Error('usage: galley models <dir> claude,gpt,gemini')
      const path = resolve(dir, 'paper.json')
      const config = JSON.parse(readFileSync(path, 'utf8'))
      config.families = modelsFlag(list)
      writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
      const dealt = Paper.readConfig(resolve(dir))
      console.log(JSON.stringify({ families: familiesOn(dealt), seats: dealt.seats, referees: dealt.referees.map((r) => ({ seat: r.seat, family: r.family })) }))
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
