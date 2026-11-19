// One call to one model family through its own CLI, as a single answer with
// no tools and no delegation. Claude runs as Opus 5.5 through `claude`, GPT as
// Sol 6.2 through Codex, Gemini as Carbon through Antigravity (`agy`). Each
// transport follows an integration already proven in production use: Codex as
// Canary calls it, Antigravity with a single-tool agent file.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLooseJson, type Schema } from './schema.js'
import type { Family } from './types.js'

export interface ModelSpec {
  family: Family
  model: string
  effort: string
}

export interface Usage {
  input: number
  cached: number
  output: number
  reasoning: number
}

export interface CallResult {
  data: unknown
  text: string
  usage: Usage
  ms: number
  spec: ModelSpec
  cached: boolean
}

export class RateLimited extends Error {}
export class ModelFailure extends Error {}

/** The Codex CLI that knows Sol 6.2: the one the ChatGPT app ships, unless overridden. */
const APP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
export function codexBin(): string {
  return process.env.GALLEY_CODEX_BIN || (existsSync(APP_CODEX) ? APP_CODEX : 'codex')
}

const TIMEOUTS: Record<Family, number> = { claude: 25 * 60_000, gpt: 30 * 60_000, gemini: 40 * 60_000 }

const LIMIT_WORDS = /usage limit|rate[ _-]?limit|quota|resource_exhausted|too many requests|\b429\b|overloaded|server_overloaded/i
// A provider that cannot be reached is waited out like a limit: an unattended run at night outlasts a network blip.
const UNREACHABLE = /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket hang up|network (error|is unreachable)|fetch failed|connection (error|reset|refused|closed)|stream disconnected|error sending request|bad gateway|service unavailable|gateway timeout|temporarily unavailable|internal server error|\b50[234]\b/i

function scrubbed(drop: RegExp): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!drop.test(key)) env[key] = value
  return env
}

interface Spawned {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

// Each CLI runs in a process group of its own; when galley stops, so do they,
// rather than finishing calls nobody will read.
const children = new Set<number>()
function stopChildren(): void {
  for (const pid of children) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
  children.clear()
}
process.once('exit', stopChildren)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => { stopChildren(); process.exit(130) })
}

function run(cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number }): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    if (child.pid) children.add(child.pid)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      timedOut = true
      // The CLIs start helpers of their own; end the whole group.
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, options.timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); if (child.pid) children.delete(child.pid); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); if (child.pid) children.delete(child.pid); resolve({ stdout, stderr, code, timedOut }) })
    child.stdin.on('error', () => { /* a CLI that exits early closes stdin; its exit code tells */ })
    child.stdin.end(options.input)
  })
}

function failure(family: Family, message: string): never {
  if (LIMIT_WORDS.test(message) || UNREACHABLE.test(message)) throw new RateLimited(`${family}: ${message.slice(0, 400)}`)
  throw new ModelFailure(`${family}: ${message.slice(0, 600)}`)
}

async function callClaude(spec: ModelSpec, prompt: string, schema: Schema, cwd: string, timeoutMs: number) {
  // The desktop app's own variables would make this a child of its session.
  const env = scrubbed(/^(CLAUDE|ANTHROPIC|CLAUDECODE)/)
  const args = ['-p', '--model', spec.model, '--effort', spec.effort, '--output-format', 'json',
    '--no-session-persistence', '--permission-mode', 'dontAsk', '--setting-sources', '', '--tools', '',
    '--strict-mcp-config', '--json-schema', JSON.stringify(schema)]
  const out = await run('claude', args, { cwd, env, input: prompt, timeoutMs })
  if (out.timedOut) failure('claude', 'timed out')
  let reply: any
  try { reply = JSON.parse(out.stdout) } catch { failure('claude', `unreadable output (exit ${out.code}): ${out.stderr || out.stdout}`) }
  if (reply.is_error) failure('claude', String(reply.result || reply.terminal_reason || 'error'))
  const usage = reply.usage || {}
  const data = reply.structured_output ?? parseLooseJson(String(reply.result ?? ''))
  return {
    data,
    text: String(reply.result ?? ''),
    usage: {
      input: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
      cached: usage.cache_read_input_tokens || 0,
      output: usage.output_tokens || 0,
      reasoning: usage.output_tokens_details?.thinking_tokens || 0,
    },
  }
}

// No shell, no apps, no plugins, no hooks, no memories and no delegation.
const CODEX_DISABLED = ['shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks', 'memories', 'browser_use', 'computer_use', 'image_generation', 'skill_search']

async function callCodex(spec: ModelSpec, prompt: string, schema: Schema, cwd: string, timeoutMs: number) {
  const env = scrubbed(/^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL)$/)
  const schemaPath = join(cwd, 'schema.json')
  const lastPath = join(cwd, 'last.json')
  writeFileSync(schemaPath, JSON.stringify(schema))
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '-C', cwd, '--model', spec.model,
    '-c', `model_reasoning_effort="${spec.effort}"`, '-c', 'web_search="disabled"', '-c', 'approval_policy="never"',
    '-c', 'project_doc_max_bytes=0', '-c', 'forced_login_method="chatgpt"',
    ...CODEX_DISABLED.flatMap((feature) => ['--disable', feature]),
    '--output-schema', schemaPath, '--output-last-message', lastPath, '--json', '--color', 'never', '-']
  const out = await run(codexBin(), args, { cwd, env, input: prompt, timeoutMs })
  if (out.timedOut) failure('gpt', 'timed out')
  const usage = { input: 0, cached: 0, output: 0, reasoning: 0 }
  const errors: string[] = []
  for (const line of out.stdout.split('\n')) {
    if (!line.trim()) continue
    let event: any
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'turn.completed' && event.usage) {
      usage.input += event.usage.input_tokens || 0
      usage.cached += event.usage.cached_input_tokens || 0
      usage.output += event.usage.output_tokens || 0
      usage.reasoning += event.usage.reasoning_output_tokens || 0
    }
    if (event.type === 'error' || event.type === 'turn.failed') errors.push(String(event.message || event.error?.message || line))
    if (event.item?.type === 'collab_tool_call' || event.item?.type === 'subagent') errors.push('delegation attempted')
  }
  if (!existsSync(lastPath)) failure('gpt', errors.join(' | ') || out.stderr || `exit ${out.code}`)
  const text = readFileSync(lastPath, 'utf8')
  return { data: parseLooseJson(text), text, usage }
}

const AGY_SETTINGS = { toolPermission: 'strict', agentMode: '', allowNonWorkspaceAccess: false, useG1Credits: false }

function agyAgent(name: string): string {
  return `---\nname: ${name}\ndescription: Answer inline from the request.\nmainAgent: true\nsubagent: false\ntools: [finish]\nmcpServers: []\ncommandExecutionPolicy: off\nexcludeDefaultComponents: true\ninheritMcp: false\ninheritCustomizations: false\n---\n`
    + 'Answer using only the material in the request. There are no files, tasks, subprocesses or subagents to inspect. '
    + 'Prepare one complete JSON object that follows the response schema exactly, then use the finish tool to deliver it. '
    + 'The finish tool is the only tool allowed. Return JSON only, with no Markdown or commentary.\n'
}

async function callAgy(spec: ModelSpec, prompt: string, schema: Schema, cwd: string, timeoutMs: number) {
  const env = scrubbed(/^(GEMINI_API_KEY|GOOGLE_API_KEY|AGY_ADC_AUTH|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GEMINI_BASE_URL)$/)
  const name = `galley-${randomUUID().slice(0, 12)}`
  const agents = join(env.HOME || homedir(), '.gemini', 'config', 'agents')
  mkdirSync(agents, { recursive: true, mode: 0o700 })
  const agentPath = join(agents, `${name}.md`)
  // Agent files of calls that were killed before they could clean up.
  for (const file of readdirSync(agents)) {
    if (!file.startsWith('galley-')) continue
    try { if (Date.now() - statSync(join(agents, file)).mtimeMs > 6 * 3_600_000) rmSync(join(agents, file), { force: true }) } catch { /* another call's */ }
  }
  const schemaPath = join(cwd, 'schema.json')
  writeFileSync(schemaPath, JSON.stringify(schema))
  writeFileSync(agentPath, agyAgent(name), { flag: 'wx' })
  const work = mkdtempSync(join(tmpdir(), 'galley-agy-'))
  try {
    const base = ['--model', spec.model, '--agent', name, '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--disable-slash-commands', '--sandbox', '--settings', JSON.stringify(AGY_SETTINGS), '--json-schema', schemaPath]
    const started = Date.now()
    let conversation: string | null = null
    let result: any = null
    let out: Spawned | null = null
    // A long answer's stream can drop on the provider's side; resume that same conversation once instead of starting over.
    for (let pass = 0; pass < 2; pass++) {
      const resume = pass > 0 && conversation
      const args = resume ? [...base, '--conversation', conversation!] : base
      const content = resume ? 'The stream was interrupted. Continue the same task and deliver the complete JSON object with the finish tool.' : prompt
      const input = JSON.stringify({ event: 'user', message: { role: 'user', content } }) + '\n'
      out = await run('agy', args, { cwd: work, env, input, timeoutMs: Math.max(60_000, timeoutMs - (Date.now() - started)) })
      if (out.timedOut) failure('gemini', 'timed out')
      result = null
      for (const line of out.stdout.split('\n')) {
        if (!line.trim()) continue
        let event: any
        try { event = JSON.parse(line) } catch { continue }
        if (event.step_update?.subagent_info) failure('gemini', 'delegation attempted')
        if (event.event === 'init' && event.conversation_id) conversation = event.conversation_id
        if (event.init?.conversation_id) conversation = event.init.conversation_id
        if (event.event === 'result') result = event.result
      }
      const interrupted = /stream was interrupted/i.test(`${JSON.stringify(result?.error ?? '')} ${out.stderr}`)
      if (result?.status === 'SUCCESS' || !interrupted || !conversation) break
    }
    if (!result || result.status !== 'SUCCESS') failure('gemini', `${JSON.stringify(result?.error ?? '')} ${out?.stderr ?? ''}`.trim() || `exit ${out?.code}`)
    const text = String(result.response ?? '')
    const data = result.structured_output ?? parseLooseJson(text)
    const usage = result.usage || {}
    return {
      data,
      text,
      usage: { input: usage.input_tokens || 0, cached: usage.cache_read_tokens || 0, output: usage.output_tokens || 0, reasoning: usage.thinking_tokens || 0 },
    }
  } finally {
    rmSync(agentPath, { force: true })
    rmSync(work, { recursive: true, force: true })
  }
}

export interface CallOptions {
  spec: ModelSpec
  prompt: string
  schema: Schema
  /** Directory holding replayable answers, keyed by the exact request. */
  cacheDir?: string
  timeoutMs?: number
}

export function requestKey(spec: ModelSpec, prompt: string, schema: Schema): string {
  return createHash('sha256').update(JSON.stringify({ spec, prompt, schema })).digest('hex').slice(0, 32)
}

/** One answer from one model. An identical earlier request replays from the cache. */
export async function callModel(options: CallOptions): Promise<CallResult> {
  const { spec, prompt, schema } = options
  const key = requestKey(spec, prompt, schema)
  if (options.cacheDir) {
    const hit = join(options.cacheDir, `${key}.json`)
    if (existsSync(hit)) {
      const saved = JSON.parse(readFileSync(hit, 'utf8'))
      return { ...saved, cached: true }
    }
  }
  const cwd = mkdtempSync(join(tmpdir(), 'galley-call-'))
  const started = Date.now()
  try {
    const timeoutMs = options.timeoutMs ?? TIMEOUTS[spec.family]
    const answer = spec.family === 'claude' ? await callClaude(spec, prompt, schema, cwd, timeoutMs)
      : spec.family === 'gpt' ? await callCodex(spec, prompt, schema, cwd, timeoutMs)
        : await callAgy(spec, prompt, schema, cwd, timeoutMs)
    const result: CallResult = { ...answer, ms: Date.now() - started, spec, cached: false }
    if (options.cacheDir) {
      mkdirSync(options.cacheDir, { recursive: true })
      writeFileSync(join(options.cacheDir, `${key}.json`), JSON.stringify(result))
    }
    return result
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
