// Settings choose identities. Only this catalog translates them into CLI selectors and effort.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ModelSpec } from './models.js'
import type { Family } from './types.js'

export const SLOTS = ['primary', 'secondary', 'tertiary'] as const
export type Slot = typeof SLOTS[number]
export const PLACES = {
  author: ['Author', 'Extracts the seed, plans and drafts the paper, and answers referees.'],
  checker: ['Checker', 'Finds evidence, checks the draft against the claims, and reconciles the ledger.'],
  challenger: ['Challenger', 'Challenges the idea, proposes directions, and reassesses the thesis.'],
  verifier: ['Verifier', 'Judges the passages behind citations and runs the calibration.'],
  methods: ['Methods referee', 'Reviews the argument, evidence, and limitations.'],
  field: ['Field referee', 'Reviews the contribution from inside its field.'],
  citations: ['Citations referee', 'Reviews citations, attribution, and prior art.'],
  editor: ['Desk editor', 'Reviews clarity, structure, and readiness for review.'],
  adjudicator: ['Adjudicator', 'Settles disputed findings. Independent selects a third model, preferring a different provider.'],
} as const
export type Place = keyof typeof PLACES
export type Places = Record<Place, Slot | 'independent'>
export type Provider = 'claude' | 'codex' | 'antigravity'

export interface CatalogModel {
  identity: string
  provider: Provider
  selector: string
  effort: string
}

export const PROVIDERS = {
  claude: { family: 'claude', name: 'Anthropic', login: 'claude auth login', prefix: 'claude-', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: { family: 'gpt', name: 'OpenAI', login: 'codex login', prefix: 'gpt-', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  antigravity: { family: 'gemini', name: 'Google', login: 'agy', prefix: 'gemini-', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
} satisfies Record<Provider, { family: Family; name: string; login: string; prefix: string; efforts: string[] }>

export function catalogModel(provider: Provider, selector: string, effort: string): CatalogModel {
  return { identity: provider === 'antigravity' ? selector : `${selector}-${effort}`, provider, selector, effort }
}

const models = [
  catalogModel('claude', 'claude-opus-5-5', 'xhigh'),
  catalogModel('claude', 'claude-opus-5-5', 'medium'),
  catalogModel('codex', 'gpt-6.2-sol', 'xhigh'),
  catalogModel('codex', 'gpt-6.2-sol', 'high'),
  catalogModel('codex', 'gpt-6.2-sol', 'medium'),
  catalogModel('antigravity', 'gemini-4-carbon-high', 'high'),
  catalogModel('antigravity', 'gemini-4-hydrogen-medium', 'medium'),
  catalogModel('codex', 'gpt-6.1-sol', 'xhigh'),
]

export interface ModelCatalog {
  models: CatalogModel[]
  slots: Record<Slot, string>
  places: Places
  checked?: { at: string; providers: Record<Provider, string> }
}

const seed: ModelCatalog = {
  models,
  slots: { primary: models[0].identity, secondary: models[2].identity, tertiary: models[5].identity },
  places: { author: 'primary', checker: 'secondary', challenger: 'tertiary', verifier: 'tertiary', methods: 'secondary', field: 'tertiary', citations: 'secondary', editor: 'tertiary', adjudicator: 'independent' },
}

export const CANARY_MODEL = models[7]
export const LEGACY_MODELS: Record<Family, CatalogModel> = { claude: models[0], gpt: models[2], gemini: models[5] }
export const LEGACY_LIGHT_MODELS: Record<Family, CatalogModel> = { claude: models[1], gpt: models[4], gemini: models[6] }

export const modelCatalogPath = (dir = process.env.GALLEY_DIR || '.galley-data') => resolve(dir, '.galley-models.json')
export const catalogRevision = (catalog: ModelCatalog) => createHash('sha256').update(JSON.stringify(catalog)).digest('hex')
export const placeKeys = Object.keys(PLACES) as Place[]

export function modelSpec(model: CatalogModel): ModelSpec {
  const { provider, selector, effort } = model
  if (!Object.hasOwn(PROVIDERS, provider) || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(selector)
    || !selector.startsWith(PROVIDERS[provider].prefix) || !PROVIDERS[provider].efforts.includes(effort) || model.identity !== catalogModel(provider, selector, effort).identity
    || (provider === 'antigravity' && !selector.endsWith(`-${effort}`))) {
    throw new Error(`Invalid catalog model: ${model.identity}`)
  }
  return { family: PROVIDERS[provider].family, model: selector, effort }
}

export const specIdentity = (spec: ModelSpec) => spec.family === 'gemini' ? spec.model : `${spec.model}-${spec.effort}`

export interface ModelRouting {
  slots: Record<Slot, CatalogModel>
  places: Places
  enabled?: Slot[]
}

export function resolveRouting(catalog: ModelCatalog): ModelRouting {
  const slots = {} as ModelRouting['slots']
  for (const slot of SLOTS) {
    const model = catalog.models.find((entry) => entry.identity === catalog.slots[slot])
    if (!model) throw new Error(`${slot} must name a model in the catalog`)
    slots[slot] = model
  }
  const routing = { slots, places: catalog.places }
  validateRouting(routing)
  return routing
}

export function readModelCatalog(path = modelCatalogPath()): ModelCatalog {
  let catalog: ModelCatalog
  try { catalog = JSON.parse(readFileSync(path, 'utf8')) as ModelCatalog } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(seed)
    throw error
  }
  const identities = new Set<string>()
  for (const model of catalog.models) {
    modelSpec(model)
    if (identities.has(model.identity)) throw new Error(`Duplicate catalog model: ${model.identity}`)
    identities.add(model.identity)
  }
  resolveRouting(catalog)
  return catalog
}

export function saveModelCatalog(catalog: ModelCatalog, path = modelCatalogPath()): void {
  resolveRouting(catalog)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } finally { rmSync(temp, { force: true }) }
}

export function modelForPlace(routing: ModelRouting, place: Place): CatalogModel {
  const slot = routing.places[place]
  if (slot === 'independent') throw new Error('Independent adjudication needs the author and referee models')
  const model = routing.slots[slot]
  if (!model) throw new Error(`No model assigned to ${place}`)
  return model
}

/** Apply an explicit project family choice to its saved model assignments. */
export function restrictRouting(routing: ModelRouting, families?: readonly Family[]): ModelRouting {
  validateRouting(routing)
  if (!families) return routing
  const enabled = SLOTS.filter((slot) => families.includes(modelSpec(routing.slots[slot]).family))
  const provider = (slot: Slot) => routing.slots[slot].provider
  if (new Set(enabled.map(provider)).size < 2) throw new Error('Choose at least two model families assigned to slots in Settings → Models.')
  const places = { ...routing.places }
  const author = places.author as Slot
  places.author = enabled.includes(author) ? author : enabled[0]
  const checker = enabled.find((slot) => provider(slot) !== provider(places.author as Slot))!
  for (const place of placeKeys) {
    const slot = places[place]
    if (place === 'author' || slot === 'independent') continue
    if (!enabled.includes(slot) || provider(slot) === provider(places.author as Slot)) {
      places[place] = place === 'adjudicator' ? 'independent' : checker
    }
  }
  return { ...routing, places, enabled }
}

export function adjudicationAssignment(routing: ModelRouting, referee: CatalogModel): CatalogModel | undefined {
  if (routing.places.adjudicator !== 'independent') return modelForPlace(routing, 'adjudicator')
  const author = modelForPlace(routing, 'author')
  const candidates = (routing.enabled ?? SLOTS).map((slot) => routing.slots[slot]).filter((model) => model.identity !== author.identity && model.identity !== referee.identity)
  return candidates.find((model) => model.provider !== author.provider && model.provider !== referee.provider) ?? (routing.enabled ? undefined : candidates[0])
}

export function adjudicatorModel(routing: ModelRouting, referee: CatalogModel): CatalogModel {
  const model = adjudicationAssignment(routing, referee)
  if (!model) throw new Error('No independent model is available for this adjudication.')
  return model
}

export const activeModelFamilies = (routing: ModelRouting): Family[] => [...new Set((routing.enabled ?? SLOTS).map((slot) => modelSpec(routing.slots[slot]).family))]

export const providerNames = (routing: ModelRouting) => [...new Set(placeKeys.flatMap((place) =>
  routing.places[place] === 'independent' ? (routing.enabled ?? SLOTS).map((slot) => PROVIDERS[routing.slots[slot].provider].name) : [PROVIDERS[modelForPlace(routing, place).provider].name]))]

export function validateRouting(routing: ModelRouting): void {
  for (const slot of SLOTS) modelSpec(routing.slots[slot])
  if (new Set(SLOTS.map((slot) => routing.slots[slot].identity)).size !== SLOTS.length) throw new Error('The three slots must use different model identities.')
  for (const place of placeKeys) {
    const slot = routing.places[place]
    if (!SLOTS.some((key) => key === slot) && !(place === 'adjudicator' && slot === 'independent')) {
      throw new Error(`Invalid slot for ${PLACES[place][0]}`)
    }
  }
}
