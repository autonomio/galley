import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { SoftwareSubject } from '../core/software-subject.js'

const exec = promisify(execFile)
const asset = fileURLToPath(new URL('./assets/software-run.py', import.meta.url))
const gitEnv = {
  PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C',
}

interface SourceFile { path: string; mode: string; oid: string }
export interface SoftwareExcerpt { path: string; url: string; text: string }
export interface SoftwareCommand { directory: string; argv: string[] }
export interface SoftwareWorkload {
  title: string
  conditions: string
  command: SoftwareCommand
}
export interface SoftwareProtocol {
  paths: string[]
  setup: SoftwareCommand[]
  validation: SoftwareCommand[]
  workloads: SoftwareWorkload[]
}
interface CapturedOutput { bytes: number; sha256: string; excerpt: string }
interface ProfileSample { seconds: number; processes: { pid: number; name: string; rssBytes: number; cpu: string }[] }
export type SoftwareRun =
  | { status: 'unavailable'; error: string }
  | { status: 'completed' | 'failed' | 'timed-out'; exitCode: number; wallSeconds: number; userSeconds: number; systemSeconds: number; peakRssBytes: number; stdout: CapturedOutput; stderr: CapturedOutput; samples?: ProfileSample[]; sampleIntervalSeconds?: number; stacks?: { tool: string; intervalMilliseconds: number; excerpt: string } | null }
export interface SoftwareBenchmark extends SoftwareWorkload {
  warmup: SoftwareRun
  runs: SoftwareRun[]
  profile?: SoftwareRun
}
export interface SoftwareFinding {
  dimension: string
  verdict: 'supported' | 'mixed' | 'contradicted' | 'unresolved'
  finding: string
  evidence: string
  nextCheck: string
}
export interface SoftwareEvaluation {
  subject: SoftwareSubject
  excerpts: SoftwareExcerpt[]
  protocol?: SoftwareProtocol
  environment?: ReturnType<typeof hostEnvironment>
  setup: SoftwareRun[]
  validation: SoftwareRun[]
  benchmarks: SoftwareBenchmark[]
  findings: SoftwareFinding[]
  thesis?: string
  nextCheck?: string
  gaps: string[]
}

export const SOFTWARE_DIMENSIONS = [
  'Domain value', 'Mechanism and design', 'Contribution and provenance', 'Correctness',
  'Computational performance', 'Operating limits', 'Reproducibility', 'Open-source reuse',
] as const

export function emptySoftwareEvaluation(subject: SoftwareSubject): SoftwareEvaluation {
  return { subject, excerpts: [], setup: [], validation: [], benchmarks: [], findings: [], gaps: [] }
}

async function gitSoftware(args: string[], cwd: string, input?: string): Promise<string> {
  // The checkout is material supplied by the author. Host Git configuration
  // could otherwise start hooks or filters while fetching or reading it.
  const child = exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args], {
    cwd, env: gitEnv, timeout: 240_000, maxBuffer: 16 << 20,
  })
  child.child.stdin?.on('error', () => {})
  child.child.stdin?.end(input)
  return (await child).stdout
}

export async function fetchSoftware(subject: SoftwareSubject, repo: string): Promise<SourceFile[]> {
  mkdirSync(repo, { recursive: true })
  if (!existsSync(join(repo, '.git'))) await gitSoftware(['init', '--quiet'], repo)
  await gitSoftware(['config', 'remote.origin.url', subject.repository + '.git'], repo)
  await gitSoftware(['config', 'remote.origin.promisor', 'true'], repo)
  await gitSoftware(['config', 'remote.origin.partialclonefilter', 'blob:none'], repo)
  if ((await gitSoftware(['rev-parse', '--verify', 'FETCH_HEAD'], repo).catch(() => '')).trim() !== subject.commit) {
    await gitSoftware(['fetch', '--quiet', '--no-tags', '--depth=1', '--filter=blob:none', 'origin', subject.commit], repo)
  }
  const sha = (await gitSoftware(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], repo)).trim()
  if (sha !== subject.commit) throw new Error('GitHub returned a different commit from the link.')
  const tree = await gitSoftware(['ls-tree', '-rz', '--full-tree', sha], repo)
  return tree.split('\0').flatMap((row) => {
    const [meta, path] = row.split('\t', 2)
    const [mode, , oid] = meta.split(' ')
    return path ? [{ path, mode, oid }] : []
  })
}

const regular = (file: SourceFile) => file.mode === '100644' || file.mode === '100755'
const sourcePath = (path: string) => path.split('/').every((part) =>
  /^[a-z0-9_.@+ -]+$/i.test(part) && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')

export function entryFiles(files: SourceFile[]): string[] {
  const preferred = files.filter((file) => regular(file) && sourcePath(file.path) && !file.path.includes('/') &&
    /^(readme|licen[cs]e|copying|makefile|cmakelists|cargo\.toml|go\.mod|package\.json|pyproject\.toml|setup\.py|requirements\.txt)(\.|$)/i.test(file.path))
  return preferred.slice(0, 10).map((file) => file.path)
}

export function softwareInventory(files: SourceFile[]): string {
  const relevant = files.filter((file) => sourcePath(file.path) && (regular(file) || file.mode === '160000'))
  const order = (file: SourceFile) => !file.path.includes('/') ? 0 : /(^|\/)(src|scripts|benchmarks?|tests?|docs|examples?)(\/|$)/i.test(file.path) ? 1 : 2
  return relevant.sort((a, b) => order(a) - order(b)).slice(0, 700)
    .map((file) => file.mode === '160000' ? file.path + ' (submodule)' : file.path).join('\n').slice(0, 24_000)
}

async function readBlob(url: string, id: string): Promise<string | null> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok || !response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > 192 * 1024) return null
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const blob = Buffer.concat(chunks)
  const oid = createHash('sha1').update(`blob ${bytes}\0`).update(blob).digest('hex')
  return oid === id && !blob.includes(0) ? blob.toString('utf8') : null
}

export async function readSoftware(subject: SoftwareSubject, files: SourceFile[], paths: string[]): Promise<SoftwareExcerpt[]> {
  const available = new Map(files.filter(regular).map((file) => [file.path, file.oid]))
  const excerpts: SoftwareExcerpt[] = []
  for (const path of new Set(paths.slice(0, 14))) {
    if (!available.has(path) || !sourcePath(path)) continue
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const raw = await readBlob(`https://raw.githubusercontent.com/${subject.name}/${subject.commit}/${encoded}`, available.get(path)!).catch(() => null)
    if (raw === null) continue
    const text = raw.slice(0, 5600).split('\n').slice(0, 180).join('\n')
    excerpts.push({ path, url: `${subject.repository}/blob/${subject.commit}/${encoded}#L1-L${text.split('\n').length}`, text })
  }
  return excerpts
}

export function excerptBlock(excerpts: SoftwareExcerpt[]): string {
  return excerpts.map(({ path, text }) => `${path}\n${text.split('\n').map((line, i) => `${i + 1} ${line}`).join('\n')}`).join('\n\n')
}

export async function checkoutSoftware(repo: string, subject: SoftwareSubject, files: SourceFile[], paths: string[]): Promise<void> {
  const entries = new Set(files.filter((file) => sourcePath(file.path)).map((file) => file.path))
  const directories = new Set<string>()
  for (const path of entries) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
  }
  const selected = [...new Set(paths)].filter((path) => entries.has(path) || directories.has(path)).slice(0, 32)
  if (!selected.length) throw new Error('The evaluation has no source paths to check out.')
  await gitSoftware(['sparse-checkout', 'set', '--no-cone', '--stdin'], repo, selected.map((path) => `/${path}${directories.has(path) ? '/' : ''}`).join('\n') + '\n')
  await gitSoftware(['checkout', '--quiet', '--detach', '--force', subject.commit], repo)
}

function hostEnvironment() {
  return { os: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length, memoryBytes: totalmem() }
}

function inside(parent: string, path: string): boolean {
  const rest = relative(parent, path)
  return !isAbsolute(rest) && rest !== '..' && !rest.startsWith('../')
}

function executionBoundary(workspace: string) {
  const rust = join(homedir(), '.rustup', 'toolchains')
  const installed = existsSync(rust) ? readdirSync(rust).sort().map((name) => join(rust, name, 'bin')).filter(existsSync) : []
  const env = {
    PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin', ...installed].join(':'),
    HOME: workspace, TMPDIR: workspace, LC_ALL: 'C', CARGO_NET_OFFLINE: 'true',
    PIP_NO_INDEX: '1', npm_config_offline: 'true', GIT_CONFIG_NOSYSTEM: '1',
  }
  if (platform() === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const work = `(subpath ${JSON.stringify(workspace)})`
    const toolchains = installed.length ? ` (subpath ${JSON.stringify(rust)})` : ''
    // Galley owns cancellation. A workload cannot signal the collector or
    // other processes running under the same user account.
    const policy = `(version 1)(allow default)(deny network*)(deny signal)(allow signal (target self))(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/Library/Keychains"))(allow file-read-data ${work}${toolchains})(deny file-write*)(allow file-write* ${work} (literal "/dev/null"))`
    return { prefix: ['/usr/bin/sandbox-exec', '-p', policy], env }
  }
  if (platform() === 'linux' && existsSync('/usr/bin/bwrap')) {
    const roots = ['/bin', '/sbin', '/usr', '/lib', '/lib64', '/etc/ld.so.conf', '/etc/ld.so.cache', '/etc/os-release', ...installed.map(dirname)].filter(existsSync)
    return { prefix: ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev',
      ...roots.flatMap((path) => ['--ro-bind', path, path]), '--bind', workspace, workspace, '--',], env }
  }
  throw new Error('No isolated software execution is available on this host.')
}

export async function runSoftwareCommand(workspace: string, repo: string, spec: SoftwareCommand, profile = false, timeout = 120): Promise<SoftwareRun> {
  try {
    const root = realpathSync(workspace)
    const working = realpathSync(repo)
    const cwd = realpathSync(join(working, spec.directory))
    if (!inside(root, working) || !inside(working, cwd) || !spec.argv[0] || spec.argv[0].startsWith('-') ||
      spec.argv.length > 30 || spec.argv.some((arg) => arg.length > 2048 || arg.includes('\0'))) {
      throw new Error('The evaluation command or its working directory is invalid.')
    }
    const { prefix, env } = executionBoundary(root)
    const request = { command: [...prefix, ...spec.argv], cwd, env, profile, timeout }
    const { stdout } = await exec('python3', [asset, JSON.stringify(request)], { env: gitEnv, timeout: (timeout + 10) * 1000, maxBuffer: 5 << 20 })
    return JSON.parse(stdout) as SoftwareRun
  } catch (error) {
    return { status: 'unavailable', error: (error as Error).message.slice(0, 400) }
  }
}

export async function executeSoftware(evaluation: SoftwareEvaluation, workspace: string, repo: string): Promise<void> {
  const protocol = evaluation.protocol!
  const root = realpathSync(workspace)
  evaluation.environment = hostEnvironment()
  executionBoundary(root)
  for (const step of protocol.setup) {
    const run = await runSoftwareCommand(root, repo, step, false, 180)
    evaluation.setup.push(run)
    if (run.status !== 'completed') {
      evaluation.gaps.push('Setup did not complete. The remaining checks used the available workspace.')
      break
    }
  }
  for (const step of protocol.validation) evaluation.validation.push(await runSoftwareCommand(root, repo, step))
  for (const workload of protocol.workloads) {
    const warmup = await runSoftwareCommand(root, repo, workload.command)
    const benchmark: SoftwareBenchmark = { ...workload, warmup, runs: [] }
    evaluation.benchmarks.push(benchmark)
    if (warmup.status !== 'completed') continue
    for (let i = 0; i < 5; i++) {
      const run = await runSoftwareCommand(root, repo, workload.command)
      benchmark.runs.push(run)
      if (run.status !== 'completed') break
    }
    benchmark.profile = await runSoftwareCommand(root, repo, workload.command, true)
  }
  if (!evaluation.validation.some((run) => run.status === 'completed')) evaluation.gaps.push('No planned validation command completed successfully.')
  if (!evaluation.benchmarks.some((benchmark) => benchmark.runs.length === 5 && benchmark.runs.every((run) => run.status === 'completed'))) evaluation.gaps.push('No workload completed all five benchmark repetitions.')
  if (!evaluation.benchmarks.some((benchmark) => benchmark.profile?.status === 'completed' && benchmark.profile.samples?.length)) evaluation.gaps.push('No workload produced a completed process profile.')
}

export function discardSoftwareCheckout(workspace: string): void {
  rmSync(workspace, { recursive: true, force: true })
}

function benchmarkRuns(benchmark: SoftwareBenchmark) {
  const runs = benchmark.runs.flatMap((run) => run.status === 'completed' ? [run] : [])
  return runs.length === 5 ? runs : []
}

export function softwareNumbers(evaluation?: SoftwareEvaluation): Record<string, string | number> {
  const numbers: Record<string, string | number> = {}
  evaluation?.benchmarks.forEach((benchmark, index) => {
    const runs = benchmarkRuns(benchmark)
    if (!runs.length) return
    const id = `software.B${index + 1}`
    const elapsed = runs.map((run) => run.wallSeconds * 1000).sort((a, b) => a - b)
    const ms = (value: number) => Number(value.toPrecision(3))
    numbers[`${id}.n`] = runs.length
    numbers[`${id}.median_ms`] = ms(elapsed[2])
    numbers[`${id}.min_ms`] = ms(elapsed[0])
    numbers[`${id}.max_ms`] = ms(elapsed[4])
    numbers[`${id}.peak_mib`] = Number((Math.max(...runs.map((run) => run.peakRssBytes)) / (1 << 20)).toPrecision(3))
  })
  return numbers
}

function runSummary(run: SoftwareRun, outputs: boolean): string {
  if (run.status === 'unavailable') return run.error
  const excerpts = outputs || run.status !== 'completed' ? [run.stdout.excerpt, run.stderr.excerpt].filter(Boolean).map((text) => text.slice(0, 480)).join('\n') : ''
  return `${run.status} (exit ${run.exitCode})${excerpts ? `\n${excerpts}` : ''}`
}

export function softwareResults(evaluation: SoftwareEvaluation, includeOutputs = false): string {
  const report = [
    evaluation.environment ? `Run host: ${JSON.stringify(evaluation.environment)}.` : '',
    ...evaluation.setup.map((run, i) => `Setup ${JSON.stringify(evaluation.protocol?.setup[i])} — ${runSummary(run, includeOutputs)}`),
    ...evaluation.validation.map((run, i) => `Validation ${JSON.stringify(evaluation.protocol?.validation[i])} — ${runSummary(run, true)}`),
    ...evaluation.benchmarks.map((b, i) => {
      const profile = b.profile
      const samples = profile?.status === 'completed' ? profile.samples ?? [] : []
      const names = [...new Set(samples.flatMap((sample) => sample.processes.map((item) => item.name)))].slice(0, 12)
      const stacks = profile?.status === 'completed' ? profile.stacks : null
      return `B${i + 1} ${b.title}: ${b.conditions}\nCommand: ${JSON.stringify(b.command)}. Warm-up: ${runSummary(b.warmup, includeOutputs)}. ${benchmarkRuns(b).length ? 'Completed five measured runs.' : 'Benchmark incomplete.'}${samples.length ? `\nProcess-level profile at a ${profile?.status === 'completed' ? profile.sampleIntervalSeconds : ''} s target interval: observed ${names.join(', ')}. Raw samples are in the evidence package.` : ''}${stacks ? `\nCall-stack excerpt from ${stacks.tool}:\n${stacks.excerpt.slice(stacks.excerpt.indexOf('Call graph:'), stacks.excerpt.indexOf('Call graph:') + 2400)}` : ''}`
    }),
    ...Object.entries(softwareNumbers(evaluation)).map(([key, value]) => `{{${key}}} = ${value}`),
    ...evaluation.gaps.map((gap) => `Evaluation gap: ${gap}`),
  ]
  return report.filter(Boolean).join('\n')
}

export function softwareEvidenceIds(evaluation?: SoftwareEvaluation): string[] {
  return [
    ...(evaluation?.findings ?? []).flatMap((finding, i) => finding.verdict === 'unresolved' ? [] : [`F${i + 1}`]),
    ...(evaluation?.benchmarks ?? []).flatMap((b, i) => benchmarkRuns(b).length ? [`B${i + 1}`] : []),
  ]
}

export const SOFTWARE_FRAMING = 'This paper introduces or evaluates the software at the supplied commit. Ground the argument in the strongest supported contribution. Explain the concrete domain task, design and upstream boundary, correctness, measured computational performance, operating limits, reproducibility, and open-source reuse. Use prior work for priority and comparative claims. Report the checks that ran and leave unestablished results out. State measured quantities as the software.* placeholders supplied with the evidence. Present each result within the tested workload, output-quality criterion, and environment. Use a comparison only where an actual comparable baseline was run or independently verified.'

export function softwareBlock(subject: SoftwareSubject, evaluation?: SoftwareEvaluation): string {
  return [
    `SOFTWARE UNDER STUDY: ${subject.name}, commit ${subject.commit}, ${subject.url}`,
    SOFTWARE_FRAMING,
    evaluation?.thesis ? `Strongest supported contribution from the evaluation: ${evaluation.thesis}` : '',
    ...(evaluation?.findings ?? []).map((f, i) => `F${i + 1} ${f.dimension} (${f.verdict}): ${f.finding} Evidence: ${f.evidence}`),
    evaluation ? softwareResults(evaluation) : '',
  ].filter(Boolean).join('\n')
}
