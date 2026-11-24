// Like Poise, discovery reads native catalogs without sending prompts.
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { catalogModel, modelSpec, PROVIDERS, type CatalogModel, type Provider } from './model-catalog.js'

const exec = promisify(execFile)

async function discover(provider: Provider): Promise<CatalogModel[]> {
  if (provider === 'codex') {
    const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json')
    const { models } = JSON.parse(readFileSync(path, 'utf8')) as {
      models: { slug: string; visibility: string; supported_reasoning_levels?: { effort: string }[] }[]
    }
    return models.filter((m) => m.visibility === 'list' && /^gpt-[0-9]/.test(m.slug))
      .flatMap((m) => (m.supported_reasoning_levels ?? []).map(({ effort }) => catalogModel(provider, m.slug, effort)))
  }
  if (provider === 'claude') {
    const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'cache', 'model-catalog')
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
      .map((name) => ({ path: join(dir, name), time: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
    if (!files.length) return []
    const { catalog } = JSON.parse(readFileSync(files[0].path, 'utf8')) as {
      catalog: { config: { models: { id: string; thinking?: { effort_options?: { id: string }[] } }[] } }
    }
    return catalog.config.models.filter((m) => /^claude-.*-\d/.test(m.id))
      .flatMap((m) => (m.thinking?.effort_options ?? []).map(({ id }) => catalogModel(provider, m.id, id)))
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GEMINI_API_KEY|GOOGLE_API_KEY|AGY_ADC_AUTH|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GEMINI_BASE_URL)$/.test(key)))
  const { stdout } = await exec('agy', ['models'], { timeout: 30_000, maxBuffer: 256_000, env })
  return stdout.split('\n').flatMap((line) => {
    const match = /^(gemini-[a-z0-9.-]+-(low|medium|high|xhigh|max))\t/.exec(line)
    return match ? [catalogModel(provider, match[1], match[2])] : []
  })
}

export async function discoverModels() {
  const providers = Object.keys(PROVIDERS) as Provider[]
  return Promise.all(providers.map(async (provider) => {
    try {
      const models = (await discover(provider)).filter((model) => {
        try { modelSpec(model); return true } catch { return false }
      })
      return { provider, models, status: models.length ? `${new Set(models.map((m) => m.identity)).size} models found` : 'No models reported' }
    } catch {
      return { provider, models: [], status: 'Model list unavailable' }
    }
  }))
}
