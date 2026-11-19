// The shared part of every simulation: named inputs, model lines, the outputs it reports and the
// events whose probabilities it counts, compiled once to closures over one slot array. Every
// method runs this same model; a method decides only how inputs (and the sequential method's
// states) get their values.
import { DISTRIBUTIONS, type Distribution } from './distributions.js'
import { check, compile, ExpressionError, nearest, parse, refsOf, RESERVED, type Fn, type Node, type Scope } from './expression.js'
import type { Draw, Input, Model, Problem, SimulationSpec } from './types.js'

/** A name a placeholder can carry: {{sim.S1.<name>.mean}}. */
export const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

/** Keys a run cites under the simulation itself ({{sim.S1.draws}}), so no quantity may take them. */
export const RUN_KEYS = ['draws', 'seed', 'particles', 'replicates', 'steps', 'ess_min', 'resampled', 'loglik', 'loglik_mcse']

export const LIMITS = { inputs: 64, lines: 64, outputs: 16, events: 16 }

export type Field = { kind: 'expr'; fn: Fn; refs: Set<string> } | { kind: 'draw'; draw: Draw; refs: Set<string> }

/** Where in the text an expression went wrong, for a problem's message. */
const located = (error: ExpressionError, text: string) => `${error.message} (in “${text}” at character ${error.at + 1})`

/** A call's arguments in its distribution's parameter order, or what is wrong with them. */
function ordered(node: Extract<Node, { k: 'call' }>, dist: Distribution): Node[] | string {
  const list = dist.params.join(' and ')
  if (dist.variadic) {
    if (node.named.some((n) => n !== null)) return `${node.name} takes its ${dist.params[0]}s in order, without names`
    return node.args.length >= 2 ? node.args : `${node.name} needs two ${dist.params[0]}s or more`
  }
  const out: (Node | undefined)[] = new Array(dist.params.length).fill(undefined)
  for (const [i, arg] of node.args.entries()) {
    const label = node.named[i]
    const at = label === null ? i : dist.params.indexOf(label)
    if (label !== null && at < 0) return `${node.name} has no parameter ${label}; its parameters are ${list}`
    if (at >= dist.params.length) return `${node.name} takes ${dist.params.length} argument${dist.params.length > 1 ? 's' : ''} (${list}), not ${node.args.length}`
    if (out[at]) return `${node.name} is given its ${dist.params[at]} twice`
    out[at] = arg
  }
  const missing = dist.params.filter((_, i) => !out[i])
  if (missing.length) return `${node.name} needs ${list}; ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing`
  return out as Node[]
}

/**
 * Compiles one field: an expression or, where `allow` lets it, a distribution whose arguments are
 * expressions. A field that is a distribution draws; anything else is computed.
 */
export function compileField(text: string, at: string, scope: Scope, allow: 'expr' | 'draw' | 'either', problems: Problem[]): Field | null {
  const say = (message: string) => { problems.push({ at, message }); return null }
  let node: Node
  try {
    node = parse(text)
  } catch (error) {
    if (error instanceof ExpressionError) return say(located(error, text))
    throw error
  }
  const slot = (name: string) => scope.slot(name)
  if (node.k === 'call' && DISTRIBUTIONS.has(node.name)) {
    if (allow === 'expr') return say(`${node.name}(…) draws a value, which only an input or a state can do; draw it there and use its name here`)
    const dist = DISTRIBUTIONS.get(node.name)!
    const args = ordered(node, dist)
    if (typeof args === 'string') return say(`${args} (in “${text}”)`)
    for (const arg of args) {
      const error = check(arg, scope)
      if (error) return say(located(error, text))
    }
    return { kind: 'draw', draw: { name: node.name, dist, args: args.map((a) => compile(a, slot)) }, refs: refsOf(node) }
  }
  if (allow === 'draw') return say(`this needs a distribution, as in normal(x, 1), not “${text}”`)
  const error = check(node, scope)
  if (error) return say(located(error, text))
  return { kind: 'expr', fn: compile(node, slot), refs: refsOf(node) }
}

/** A scope over some of a model's names. */
export function scopeOf(slots: Map<string, number>, names: Iterable<string>): Scope {
  const set = new Set(names)
  return { has: (n) => set.has(n), names: () => set, slot: (n) => slots.get(n)! }
}

/** Draws one value: NaN when the arguments are outside what the distribution allows. */
export function drawValue(draw: Draw, args: Float64Array, u: number): number {
  const n = draw.args.length
  return draw.dist.invalid(args, n) ? NaN : draw.dist.quantile(u, args, n)
}

/**
 * Checks and compiles the shared part of a spec. `extra` are the names a method adds (the
 * sequential method's states, and t). Problems are pushed, never thrown; the model comes back
 * either way, so a method can report its own problems alongside.
 */
export function compileModel(spec: SimulationSpec, extra: { name: string; at: string; system?: boolean }[], problems: Problem[]): Model {
  const say = (at: string, message: string) => problems.push({ at, message })
  const declared: { name: string; at: string; system?: boolean }[] = [
    ...spec.inputs.map((x, i) => ({ name: x.name, at: `inputs[${i}].name` })),
    ...extra,
    ...spec.model.map((x, i) => ({ name: x.name, at: `model[${i}].name` })),
    ...spec.events.map((x, i) => ({ name: x.name, at: `events[${i}].name` })),
  ]
  for (const [what, list, max] of [['inputs', spec.inputs, LIMITS.inputs], ['model lines', spec.model, LIMITS.lines], ['outputs', spec.outputs, LIMITS.outputs], ['events', spec.events, LIMITS.events]] as const) {
    if (list.length > max) say(what === 'model lines' ? 'model' : what, `at most ${max} ${what}, not ${list.length}`)
  }
  const seen = new Map<string, string>()
  for (const d of declared) {
    if (!d.system) {
      if (!NAME.test(d.name)) say(d.at, `“${d.name}” is not a name: it starts with a letter and holds letters, digits and _, at most 40`)
      else if (RESERVED.has(d.name) || RUN_KEYS.includes(d.name)) say(d.at, `${d.name} is a reserved word; choose another name`)
    }
    const key = d.name.toLowerCase()
    if (seen.has(key)) say(d.at, `another quantity is already called ${seen.get(key)}`)
    else seen.set(key, d.name)
  }
  const slots = new Map<string, number>()
  for (const d of declared) if (!slots.has(d.name)) slots.set(d.name, slots.size)
  const size = slots.size
  const inputNames = spec.inputs.map((x) => x.name)
  const quantities = [...inputNames, ...extra.map((x) => x.name), ...spec.model.map((x) => x.name)]
  const everything = scopeOf(slots, quantities)
  const empty = new Float64Array(size)

  const inputs: Input[] = []
  for (const [i, x] of spec.inputs.entries()) {
    const at = `inputs[${i}].dist`
    const field = compileField(x.dist, at, everything, 'either', problems)
    if (!field) continue
    if (field.refs.size) {
      say(at, `an input's distribution takes numbers, so it cannot read ${[...field.refs].join(', ')}; compute the dependence in the model, or state it as a correlation`)
      continue
    }
    if (field.kind === 'draw') {
      const args = Float64Array.from(field.draw.args, (f) => f(empty))
      const invalid = field.draw.dist.invalid(args, args.length)
      if (invalid) say(at, `${field.draw.name}(${[...args].join(', ')}): ${invalid}`)
      else inputs.push({ name: x.name, slot: slots.get(x.name)!, draw: field.draw, args, value: NaN })
    } else {
      const value = field.fn(empty)
      if (!Number.isFinite(value)) say(at, `a fixed value must be a finite number, not ${value}`)
      else inputs.push({ name: x.name, slot: slots.get(x.name)!, draw: null, args: new Float64Array(0), value })
    }
  }

  // Model lines may come in any order: they run in the order of what they read, and a loop is a problem.
  const compiled = new Map<string, { fn: Fn; reads: string[]; at: string }>()
  for (const [i, x] of spec.model.entries()) {
    const at = `model[${i}].expr`
    const field = compileField(x.expr, at, everything, 'expr', problems)
    if (field?.kind === 'expr') compiled.set(x.name, { fn: field.fn, reads: [...field.refs].filter((r) => spec.model.some((m) => m.name === r)), at })
  }
  const lines: Model['lines'] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (name: string, path: string[]) => {
    if (state.get(name) === 'done') return
    const line = compiled.get(name)
    if (!line) return
    if (state.get(name) === 'visiting') {
      say(line.at, `it closes a loop: ${[...path.slice(path.indexOf(name)), name].join(' → ')}`)
      return
    }
    state.set(name, 'visiting')
    for (const r of line.reads) visit(r, [...path, name])
    state.set(name, 'done')
    lines.push({ name, slot: slots.get(name)!, fn: line.fn })
  }
  for (const x of spec.model) visit(x.name, [])

  const eventNames = new Set(spec.events.map((x) => x.name))
  const reportable = new Set(quantities.filter((n) => !extra.some((x) => x.system && x.name === n)))
  const outputs: Model['outputs'] = []
  for (const [i, name] of spec.outputs.entries()) {
    if (eventNames.has(name) || outputs.some((o) => o.name === name)) continue
    if (!reportable.has(name)) {
      const near = nearest(name, reportable)
      say(`outputs[${i}]`, `nothing is called ${name}${near ? `; did you mean ${near}?` : ''}`)
    } else outputs.push({ name, slot: slots.get(name)! })
  }
  if (!spec.outputs.length && !spec.events.length) say('outputs', 'name at least one output or event to report')

  const events: Model['events'] = []
  for (const [i, x] of spec.events.entries()) {
    const field = compileField(x.when, `events[${i}].when`, everything, 'expr', problems)
    if (field?.kind === 'expr') events.push({ name: x.name, slot: slots.get(x.name)!, fn: field.fn })
  }

  return {
    slots, size, inputs, lines, outputs, events,
    derive(env) {
      for (const line of lines) env[line.slot] = line.fn(env)
      for (const event of events) env[event.slot] = event.fn(env)
    },
  }
}
