// The spec a model writes, its JSON schema in the strict dialect every provider accepts, and the
// reading of a reply into a spec: lenient about form (a missing optional field is null, a number
// where text belongs is read as text), exact about meaning, and every problem located.
import { arr, enm, num, nobj, obj, str, type Schema } from '../schema.js'
import { nearest } from './expression.js'
import { METHODS } from './methods/index.js'
import { NAME } from './model.js'
import type { Problem, Resampling, SequentialSpec, SimulationSpec } from './types.js'

export const RESAMPLING: readonly Resampling[] = ['systematic', 'stratified', 'multinomial']

const nullable = (type: 'integer' | 'number', description: string): Schema => ({ type: [type, 'null'], description })

/** The schema a model's reply follows: every field present, optional values null. */
export const specSchema: Schema = obj({
  id: str('A short name such as S1; every result is cited as {{sim.<id>.<name>.<stat>}}'),
  title: str('What is simulated, in one sentence'),
  method: enm([...METHODS.keys()]),
  seed: nullable('integer', 'A whole number; null for 1'),
  draws: nullable('integer', 'Draws, for monte_carlo and correlated; null for 20000'),
  inputs: arr(obj({ name: str(), dist: str('A distribution with numbers for arguments, such as triangular(80, 100, 150), or one fixed value') })),
  model: arr(obj({ name: str(), expr: str('An expression over the inputs, the states and other model lines') })),
  outputs: arr(str('The name of an input, a state or a model line to report')),
  events: arr(obj({ name: str(), when: str('A condition on one draw, such as profit < 0') })),
  correlations: arr(obj({ a: str(), b: str(), rho: num('Rank (Spearman) correlation between inputs a and b, from -1 to 1') })),
  sequential: nobj({
    states: arr(obj({ name: str(), init: str('Its distribution or value before the first step'), next: str('Its distribution or value at each step') })),
    observations: arr(obj({ name: str(), values: arr({ type: ['number', 'null'] }), likelihood: str('The distribution of one observation given the state') })),
    steps: nullable('integer', 'Steps to run when nothing is observed; null otherwise'),
    particles: nullable('integer', 'Particles per filter; null for 1000'),
    replicates: nullable('integer', 'Independent filters; null for 8'),
    resample: enm(RESAMPLING),
    threshold: nullable('number', 'Resample when the effective sample size falls below this share of the particles; null for 0.5'),
  }),
})

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads a spec from JSON a model or a person wrote, filling defaults and locating every problem. */
export function readSpec(raw: unknown): { spec: SimulationSpec | null; problems: Problem[] } {
  const problems: Problem[] = []
  const say = (at: string, message: string) => problems.push({ at, message })
  if (!isRecord(raw)) return { spec: null, problems: [{ at: '', message: 'a simulation is a JSON object' }] }
  const absent = (v: unknown) => v === undefined || v === null
  const text = (v: unknown, at: string, fallback?: string): string => {
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    if (absent(v) && fallback !== undefined) return fallback
    say(at, absent(v) ? 'it is missing' : 'it must be text')
    return ''
  }
  const whole = (v: unknown, at: string): number | null => {
    if (absent(v)) return null
    if (typeof v === 'number' && Number.isInteger(v)) return v
    say(at, 'it must be a whole number, or null')
    return null
  }
  const real = (v: unknown, at: string): number | null => {
    if (absent(v)) return null
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    say(at, 'it must be a number, or null')
    return null
  }
  const list = <T>(v: unknown, at: string, item: (x: unknown, at: string) => T): T[] => {
    if (absent(v)) return []
    if (!Array.isArray(v)) { say(at, 'it must be a list'); return [] }
    return v.map((x, i) => item(x, `${at}[${i}]`))
  }
  const record = (v: unknown, at: string): Record<string, unknown> => {
    if (isRecord(v)) return v
    say(at, 'it must be an object')
    return {}
  }

  const id = text(raw.id, 'id')
  if (id && !NAME.test(id)) say('id', `“${id}” cannot name results: it starts with a letter and holds letters, digits and _, as S1 does`)
  const method = text(raw.method, 'method')
  if (method && !METHODS.has(method)) {
    const near = nearest(method, METHODS.keys())
    say('method', `there is no method “${method}”${near ? `; did you mean ${near}?` : ''} The methods are ${[...METHODS.keys()].join(', ')}`)
  }
  const seed = whole(raw.seed, 'seed')
  if (seed !== null && !(seed >= 0 && seed <= 4294967295)) say('seed', 'a seed is a whole number from 0 to 4294967295')

  const spec: SimulationSpec = {
    id,
    title: text(raw.title, 'title', id),
    method,
    seed,
    draws: whole(raw.draws, 'draws'),
    inputs: list(raw.inputs, 'inputs', (x, at) => { const r = record(x, at); return { name: text(r.name, `${at}.name`), dist: text(r.dist, `${at}.dist`) } }),
    model: list(raw.model, 'model', (x, at) => { const r = record(x, at); return { name: text(r.name, `${at}.name`), expr: text(r.expr, `${at}.expr`) } }),
    outputs: list(raw.outputs, 'outputs', (x, at) => text(x, at)),
    events: list(raw.events, 'events', (x, at) => { const r = record(x, at); return { name: text(r.name, `${at}.name`), when: text(r.when, `${at}.when`) } }),
    correlations: list(raw.correlations, 'correlations', (x, at) => {
      const r = record(x, at)
      const rho = real(r.rho, `${at}.rho`)
      if (rho === null && absent(r.rho)) say(`${at}.rho`, 'it is missing')
      return { a: text(r.a, `${at}.a`), b: text(r.b, `${at}.b`), rho: rho ?? NaN }
    }),
    sequential: null,
  }
  if (!absent(raw.sequential)) {
    const s = record(raw.sequential, 'sequential')
    const resample = absent(s.resample) ? null : text(s.resample, 'sequential.resample')
    if (resample !== null && !RESAMPLING.includes(resample as Resampling)) say('sequential.resample', `resampling is ${RESAMPLING.join(', ')}, not “${resample}”`)
    const sequential: SequentialSpec = {
      states: list(s.states, 'sequential.states', (x, at) => { const r = record(x, at); return { name: text(r.name, `${at}.name`), init: text(r.init, `${at}.init`), next: text(r.next, `${at}.next`) } }),
      observations: list(s.observations, 'sequential.observations', (x, at) => {
        const r = record(x, at)
        return {
          name: text(r.name, `${at}.name`, `observations ${at.slice(at.indexOf('[') + 1, -1)}`),
          values: list(r.values, `${at}.values`, (v, vat) => (absent(v) ? null : real(v, vat))),
          likelihood: text(r.likelihood, `${at}.likelihood`),
        }
      }),
      steps: whole(s.steps, 'sequential.steps'),
      particles: whole(s.particles, 'sequential.particles'),
      replicates: whole(s.replicates, 'sequential.replicates'),
      resample: RESAMPLING.includes(resample as Resampling) ? (resample as Resampling) : null,
      threshold: real(s.threshold, 'sequential.threshold'),
    }
    spec.sequential = sequential
  }
  return { spec, problems }
}
