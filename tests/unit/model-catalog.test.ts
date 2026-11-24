import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { adjudicationAssignment, adjudicatorModel, catalogModel, modelSpec, modelForPlace, readModelCatalog, resolveRouting, restrictRouting, saveModelCatalog } from '../../src/engine/model-catalog.js'
import { refereesFor } from '../../src/engine/behaviors/review.js'
import { Paper } from '../../src/engine/paper.js'
import { obj, str } from '../../src/engine/schema.js'

let dir: string
afterEach(() => {
  vi.unstubAllEnvs()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

it('pins exact model and effort per role, including two Codex identities and disposition', async () => {
  dir = mkdtempSync(join(tmpdir(), 'galley-models-'))
  vi.stubEnv('GALLEY_DIR', dir)
  const catalog = readModelCatalog()
  const defaultPrimary = catalog.slots.primary
  catalog.slots.primary = 'gpt-6.2-sol-high'
  const routing = resolveRouting(catalog)
  expect(modelForPlace(routing, 'methods').identity).toBe('gpt-6.2-sol-xhigh')
  expect(adjudicatorModel(routing, modelForPlace(routing, 'methods')).identity).toBe('gemini-4-carbon-high')
  saveModelCatalog(catalog)

  const path = join(dir, 'paper')
  const paper = Paper.create(path, 'seed')
  catalog.slots.primary = defaultPrimary
  saveModelCatalog(catalog)
  const resumed = Paper.open(path)
  expect(refereesFor(resumed, 2)).toEqual(refereesFor(paper, 1))
  expect(resumed.modelFor({ seat: 'referee', referee: 'methods', family: 'gpt', light: true })).toEqual({ family: 'gpt', model: 'gpt-6.2-sol', effort: 'xhigh' })

  const bin = join(dir, 'fake-codex')
  writeFileSync(bin, `#!/bin/sh
model=
effort=
last=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model) model="$2"; shift ;;
    model_reasoning_effort=*) effort="$1" ;;
    --output-last-message) last="$2"; shift ;;
  esac
  shift
done
[ "$model" = gpt-6.2-sol ] || exit 7
[ "$effort" = 'model_reasoning_effort="high"' ] || exit 8
printf '{"value":"answer"}' > "$last"
`)
  chmodSync(bin, 0o700)
  vi.stubEnv('GALLEY_CODEX_BIN', bin)
  const request = { behavior: 'extract', target: 'seed', seat: 'author', family: 'claude' as const, schema: obj({ value: str() }) }
  await expect(resumed.ask({ ...request, prompt: 'first' })).resolves.toEqual({ value: 'answer' })
  const event = readFileSync(join(path, 'journal.jsonl'), 'utf8').trim().split('\n').pop()!
  expect(JSON.parse(event)).toMatchObject({ family: 'gpt', model: 'gpt-6.2-sol', effort: 'high' })

  writeFileSync(bin, readFileSync(bin, 'utf8') + "printf 'Falling back to model gpt-default\\n' >&2\n")
  await expect(resumed.ask({ ...request, prompt: 'second' })).rejects.toThrow('Falling back to model gpt-default')
})

it('refuses duplicate or unknown models and invalid role assignments', () => {
  dir = mkdtempSync(join(tmpdir(), 'galley-models-'))
  const path = join(dir, 'settings.json')
  const catalog = readModelCatalog(path)
  expect(() => saveModelCatalog({ ...catalog, slots: { ...catalog.slots, primary: catalog.slots.secondary } }, path)).toThrow('different model identities')
  expect(() => saveModelCatalog({ ...catalog, slots: { ...catalog.slots, primary: 'unknown' } }, path)).toThrow('model in the catalog')
  expect(() => modelSpec(catalogModel('claude', 'gpt-6.2-sol', 'high'))).toThrow('Invalid catalog model')
  expect(() => saveModelCatalog({ ...catalog, places: { ...catalog.places, author: 'independent' } }, path)).toThrow('Invalid slot for Author')
})

it('preserves the saved exact models when an existing project changes its allowed families', () => {
  dir = mkdtempSync(join(tmpdir(), 'galley-models-'))
  const routing = resolveRouting(readModelCatalog(join(dir, 'catalog.json')))
  const path = join(dir, 'paper')
  const paper = Paper.create(path, 'seed', { routing })
  expect(paper.config.seats.author).toBe('claude')
  expect(paper.webModel()?.model).toBe(routing.slots.secondary.selector)
  const configPath = join(path, 'paper.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  writeFileSync(configPath, JSON.stringify({ ...config, families: ['gpt', 'gemini'] }))
  expect(paper.refreshFamilies()).toBe(true)
  const selected = paper.config.routing!
  expect(modelForPlace(selected, 'author').identity).toBe(routing.slots.secondary.identity)
  expect(modelForPlace(selected, 'checker').identity).toBe(routing.slots.tertiary.identity)
  expect(paper.webModel()?.model).toBe(routing.slots.secondary.selector)
  expect(adjudicationAssignment(selected, modelForPlace(selected, 'checker'))).toBeUndefined()
  expect(Paper.open(path).config.routing?.places).toEqual(restrictRouting(routing, ['gpt', 'gemini']).places)
})
