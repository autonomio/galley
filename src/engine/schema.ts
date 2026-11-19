// JSON Schema in the strict dialect every provider accepts: every object closes
// its properties and requires all of them; optional values are nullable.

export type Schema = Record<string, unknown>

export const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) })
export const nstr = (description?: string): Schema => ({ type: ['string', 'null'], ...(description ? { description } : {}) })
export const num = (description?: string): Schema => ({ type: 'number', ...(description ? { description } : {}) })
export const int = (description?: string): Schema => ({ type: 'integer', ...(description ? { description } : {}) })
export const bool = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) })
export const enm = (values: readonly string[], description?: string): Schema => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) })
export const arr = (items: Schema, description?: string): Schema => ({ type: 'array', items, ...(description ? { description } : {}) })
export const obj = (properties: Record<string, Schema>, description?: string): Schema => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...(description ? { description } : {}),
})
export const nobj = (properties: Record<string, Schema>, description?: string): Schema => ({
  ...obj(properties, description),
  type: ['object', 'null'],
})

/** Pull the first JSON object out of a model's text reply (fences and prose tolerated). */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim()
  try { return JSON.parse(trimmed) } catch { /* fall through */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    try { return JSON.parse(fenced[1]) } catch { /* fall through */ }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
  throw new Error('no JSON object in reply')
}
