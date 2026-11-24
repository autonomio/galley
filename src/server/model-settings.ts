import type { IncomingMessage, ServerResponse } from 'node:http'
import { CANARY_MODEL, catalogRevision, modelSpec, placeKeys, PLACES, PROVIDERS, readModelCatalog, resolveRouting, saveModelCatalog, SLOTS, type ModelCatalog, type Place, type Places, type Provider } from '../engine/model-catalog.js'
import { discoverModels } from '../engine/model-discovery.js'
import { testModel } from '../engine/models.js'

export function modelSettingsHandler(path: string) {
  const read = () => readModelCatalog(path)
  const save = (catalog: ModelCatalog) => saveModelCatalog(catalog, path)
  const accounts = Object.entries(PROVIDERS).map(([provider, { name, login }]) => ({ provider, name, login }))
  const payload = (catalog: ModelCatalog) => ({
    ...catalog,
    revision: catalogRevision(catalog),
    roles: placeKeys.map((key) => ({ key, label: PLACES[key][0], description: PLACES[key][1] })),
    accounts,
    canary: CANARY_MODEL.identity,
  })
  let checking: Promise<void> | undefined
  const testing = new Set<Provider>()

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const route = req.url?.split('?')[0] || '/'
    try {
      if (req.method === 'GET' && route === '/') return send(200, payload(read()))
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Expected JSON.' })
      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 4096) return send(413, { error: 'Request too large.' })
      }
      const body = JSON.parse(raw) as { revision?: string; slots?: ModelCatalog['slots']; place?: Place; slot?: Places[Place]; identity?: string }
      if (req.method === 'PUT' && route === '/') {
        const catalog = read()
        if (body.revision !== catalogRevision(catalog)) return send(409, { error: 'The model settings changed in another tab.', current: payload(catalog) })
        if (body.slots && !body.place) {
          catalog.slots = Object.fromEntries(SLOTS.map((slot) => [slot, body.slots![slot]])) as ModelCatalog['slots']
        } else if (body.place && body.slot && !body.slots && placeKeys.includes(body.place)) {
          catalog.places[body.place] = body.slot
        } else {
          return send(400, { error: 'Choose three models or assign one role.' })
        }
        resolveRouting(catalog)
        save(catalog)
        return send(200, payload(catalog))
      }
      if (req.method === 'POST' && route === '/refresh') {
        checking ??= (async () => {
          const reports = await discoverModels()
          const catalog = read()
          const models = new Map(catalog.models.map((model) => [model.identity, model]))
          // Retain the exact choices already recorded, including ones a provider stops listing.
          for (const report of reports) {
            for (const model of report.models) if (!models.has(model.identity)) models.set(model.identity, model)
          }
          catalog.models = [...models.values()]
          catalog.checked = { at: new Date().toISOString(), providers: Object.fromEntries(reports.map((r) => [r.provider, r.status])) as Record<Provider, string> }
          save(catalog)
        })().finally(() => { checking = undefined })
        await checking
        return send(200, payload(read()))
      }
      if (req.method === 'POST' && route === '/test') {
        const model = read().models.find((entry) => entry.identity === body.identity)
        if (!model) return send(400, { error: 'Choose a model from the catalog.' })
        if (testing.has(model.provider)) return send(409, { error: 'A model from this provider is already being tested.' })
        testing.add(model.provider)
        try {
          await testModel(modelSpec(model), 60_000)
          return send(200, { identity: model.identity })
        } finally { testing.delete(model.provider) }
      }
      return send(404, { error: 'Not found.' })
    } catch (error) {
      return send(400, { error: (error as Error).message })
    }
  }
}
