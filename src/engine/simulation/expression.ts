// The expression language of a simulation: numbers and names, + - * / ^, comparisons that give 1
// or 0, and, or, not, a fixed table of functions, and distributions where a field may draw. A
// hand-written tokenizer and parser build a tree, and the tree compiles to closures over one
// slot array. Nothing a model writes reaches eval or Function: a name is a slot or an entry in
// the tables below, and anything else is a problem reported where it was written.
import { DISTRIBUTIONS } from './distributions.js'
import { normalCdf } from './special.js'

export type BinOp = '+' | '-' | '*' | '/' | '^' | '<' | '<=' | '>' | '>=' | '==' | '!=' | 'and' | 'or'

export type Node =
  | { k: 'num'; v: number; at: number }
  | { k: 'ref'; name: string; at: number }
  | { k: 'neg' | 'not'; a: Node; at: number }
  | { k: 'bin'; op: BinOp; a: Node; b: Node; at: number }
  | { k: 'call'; name: string; args: Node[]; named: (string | null)[]; at: number }

export type Fn = (env: Float64Array) => number

interface FunctionDef {
  /** Fewest and most arguments. */
  args: readonly [number, number]
  about: string
  f?: (a: number, b: number, c: number) => number
}

// if, pick, min and max compile on their own: if and pick evaluate only the branch they take, and
// min and max pass a NaN through where Math.min would need its arguments spread.
export const FUNCTIONS: ReadonlyMap<string, FunctionDef> = new Map<string, FunctionDef>([
  ['if', { args: [3, 3], about: 'if(condition, then, else)' }],
  ['pick', { args: [2, Infinity], about: 'pick(i, a, b, …): the i-th of the values after i' }],
  ['min', { args: [2, Infinity], about: 'the smallest of its values' }],
  ['max', { args: [2, Infinity], about: 'the largest of its values' }],
  ['abs', { args: [1, 1], about: 'absolute value', f: Math.abs }],
  ['sqrt', { args: [1, 1], about: 'square root', f: Math.sqrt }],
  ['exp', { args: [1, 1], about: 'e to the power x', f: Math.exp }],
  ['log', { args: [1, 1], about: 'natural logarithm', f: Math.log }],
  ['log10', { args: [1, 1], about: 'base-10 logarithm', f: Math.log10 }],
  ['pow', { args: [2, 2], about: 'pow(x, y) = x ^ y', f: (a, b) => a ** b }],
  ['floor', { args: [1, 1], about: 'round down', f: Math.floor }],
  ['ceil', { args: [1, 1], about: 'round up', f: Math.ceil }],
  ['round', { args: [1, 1], about: 'round to the nearest whole number, halves up', f: Math.round }],
  ['clamp', { args: [3, 3], about: 'clamp(x, lo, hi)', f: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) }],
  ['logistic', { args: [1, 1], about: '1 / (1 + exp(-x))', f: (x) => 1 / (1 + Math.exp(-x)) }],
  ['logit', { args: [1, 1], about: 'log(p / (1 - p))', f: (p) => Math.log(p / (1 - p)) }],
  ['normcdf', { args: [1, 1], about: 'the standard normal distribution function', f: normalCdf }],
  ['sin', { args: [1, 1], about: 'sine', f: Math.sin }],
  ['cos', { args: [1, 1], about: 'cosine', f: Math.cos }],
  ['tan', { args: [1, 1], about: 'tangent', f: Math.tan }],
  ['atan', { args: [1, 1], about: 'arctangent', f: Math.atan }],
])

export const CONSTANTS: ReadonlyMap<string, number> = new Map([['pi', Math.PI], ['e', Math.E], ['inf', Infinity]])
const KEYWORDS = new Set(['and', 'or', 'not'])

/** Names a quantity may not take: the language's own words, and t, the sequential method's step. */
export const RESERVED: ReadonlySet<string> = new Set([...FUNCTIONS.keys(), ...DISTRIBUTIONS.keys(), ...CONSTANTS.keys(), ...KEYWORDS, 't'])

export class ExpressionError extends Error {
  constructor(message: string, readonly at: number) {
    super(message)
  }
}

interface Token {
  kind: 'num' | 'name' | 'op' | 'end'
  text: string
  at: number
}

const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y
const SPACE = /\s+/y
// Longest first, so <= is never read as < then =.
const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '**', '+', '-', '*', '/', '^', '<', '>', '!', '=', '(', ')', ',']

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const match = (pattern: RegExp, at: number) => {
    pattern.lastIndex = at
    return pattern.exec(text)?.[0] ?? null
  }
  let i = 0
  while (i < text.length) {
    const space = match(SPACE, i)
    if (space) { i += space.length; continue }
    const number = match(NUMBER, i)
    if (number) { tokens.push({ kind: 'num', text: number, at: i }); i += number.length; continue }
    const word = match(WORD, i)
    if (word) { tokens.push({ kind: 'name', text: word, at: i }); i += word.length; continue }
    const op = OPERATORS.find((o) => text.startsWith(o, i))
    if (op) { tokens.push({ kind: 'op', text: op, at: i }); i += op.length; continue }
    throw new ExpressionError(text[i] === '.' ? 'a dot belongs only inside a number' : `“${text[i]}” is not part of the language`, i)
  }
  tokens.push({ kind: 'end', text: '', at: text.length })
  return tokens
}

const COMPARISONS = ['<', '<=', '>', '>=', '==', '!=']

/** Parses an expression into its tree; throws an ExpressionError that says where it went wrong. */
export function parse(text: string): Node {
  const tokens = tokenize(text)
  let pos = 0
  const peek = () => tokens[pos]
  const isOp = (...ops: string[]) => peek().kind === 'op' && ops.includes(peek().text)
  const isWord = (word: string) => peek().kind === 'name' && peek().text === word
  const fail = (message: string, at = peek().at): never => { throw new ExpressionError(message, at) }

  const or = (): Node => {
    let a = and()
    while (isWord('or') || isOp('||')) { const at = tokens[pos++].at; a = { k: 'bin', op: 'or', a, b: and(), at } }
    return a
  }
  const and = (): Node => {
    let a = not()
    while (isWord('and') || isOp('&&')) { const at = tokens[pos++].at; a = { k: 'bin', op: 'and', a, b: not(), at } }
    return a
  }
  const not = (): Node => {
    if (isWord('not') || isOp('!')) { const at = tokens[pos++].at; return { k: 'not', a: not(), at } }
    return compare()
  }
  const compare = (): Node => {
    const a = sum()
    if (isOp(...COMPARISONS)) {
      const t = tokens[pos++]
      const b = sum()
      if (isOp(...COMPARISONS)) fail('comparisons do not chain: join them with and, as in a < b and b < c')
      return { k: 'bin', op: t.text as BinOp, a, b, at: t.at }
    }
    if (isOp('=')) fail('compare with ==; a single = only names an argument, as in gamma(shape = 2, rate = 1)')
    return a
  }
  const sum = (): Node => {
    let a = product()
    while (isOp('+', '-')) { const t = tokens[pos++]; a = { k: 'bin', op: t.text as BinOp, a, b: product(), at: t.at } }
    return a
  }
  const product = (): Node => {
    let a = unary()
    while (isOp('*', '/')) { const t = tokens[pos++]; a = { k: 'bin', op: t.text as BinOp, a, b: unary(), at: t.at } }
    return a
  }
  // A minus sign binds looser than ^, so -x^2 is -(x^2); an exponent may carry its own sign, as in 2^-1.
  const unary = (): Node => {
    if (isOp('-')) { const at = tokens[pos++].at; return { k: 'neg', a: unary(), at } }
    if (isOp('+')) { pos++; return unary() }
    return power()
  }
  const power = (): Node => {
    const a = primary()
    if (isOp('^', '**')) { const at = tokens[pos++].at; return { k: 'bin', op: '^', a, b: unary(), at } }
    return a
  }
  const primary = (): Node => {
    const t = peek()
    if (t.kind === 'num') { pos++; return { k: 'num', v: Number(t.text), at: t.at } }
    if (t.kind === 'name') {
      if (KEYWORDS.has(t.text)) fail(`${t.text} needs a value before it`)
      pos++
      return isOp('(') ? call(t) : { k: 'ref', name: t.text, at: t.at }
    }
    if (isOp('(')) {
      pos++
      const inner = or()
      if (!isOp(')')) fail('a bracket is not closed', t.at)
      pos++
      return inner
    }
    if (t.kind === 'end') fail(tokens.length === 1 ? 'it is empty' : 'a value is missing at the end')
    return fail(t.text === ')' ? 'a bracket closes that was never opened' : `a value is missing before “${t.text}”`)
  }
  const call = (name: Token): Node => {
    pos++
    const args: Node[] = []
    const named: (string | null)[] = []
    if (!isOp(')')) {
      for (;;) {
        let label: string | null = null
        const next = tokens[pos + 1]
        if (peek().kind === 'name' && next.kind === 'op' && next.text === '=') { label = peek().text; pos += 2 }
        else if (named.some((n) => n !== null)) fail('after a named argument every argument needs its name')
        args.push(or())
        named.push(label)
        if (!isOp(',')) break
        pos++
      }
    }
    if (!isOp(')')) fail(`the bracket of ${name.text}( is not closed`, name.at)
    pos++
    return { k: 'call', name: name.text, args, named, at: name.at }
  }

  const node = or()
  if (peek().kind !== 'end') fail(`“${peek().text}” does not follow from what comes before it`)
  return node
}

/** The names a tree reads, constants left out. */
export function refsOf(node: Node, into = new Set<string>()): Set<string> {
  if (node.k === 'ref') { if (!CONSTANTS.has(node.name)) into.add(node.name) }
  else if (node.k === 'neg' || node.k === 'not') refsOf(node.a, into)
  else if (node.k === 'bin') { refsOf(node.a, into); refsOf(node.b, into) }
  else if (node.k === 'call') for (const a of node.args) refsOf(a, into)
  return into
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

/** The known name closest to a misspelt one, when it is close enough to be the likely intent. */
export function nearest(word: string, known: Iterable<string>): string | null {
  let best: string | null = null
  let score = Infinity
  for (const name of known) {
    const d = distance(word.toLowerCase(), name.toLowerCase())
    if (d < score) { score = d; best = name }
  }
  return best !== null && score <= Math.max(2, Math.floor(word.length / 3)) ? best : null
}

const suggest = (word: string, known: Iterable<string>) => {
  const near = nearest(word, known)
  return near ? `; did you mean ${near}?` : ''
}

export interface Scope {
  has(name: string): boolean
  names(): Iterable<string>
  slot(name: string): number
}

/**
 * The first thing that keeps a tree from running: an unknown name, a call to something that is
 * not a function, or a wrong number of arguments. Distributions are not values inside an
 * expression; only a field that draws may be one.
 */
export function check(node: Node, scope: Scope): ExpressionError | null {
  switch (node.k) {
    case 'num':
      return null
    case 'ref': {
      if (CONSTANTS.has(node.name) || scope.has(node.name)) return null
      if (FUNCTIONS.has(node.name)) return new ExpressionError(`${node.name} is a function: write ${node.name}(…)`, node.at)
      if (DISTRIBUTIONS.has(node.name)) return new ExpressionError(`${node.name} is a distribution, not a value here`, node.at)
      return new ExpressionError(`nothing is called ${node.name}${suggest(node.name, scope.names())}`, node.at)
    }
    case 'neg':
    case 'not':
      return check(node.a, scope)
    case 'bin':
      return check(node.a, scope) ?? check(node.b, scope)
    case 'call': {
      if (DISTRIBUTIONS.has(node.name)) return new ExpressionError(`${node.name}(…) draws a value, which only an input or a state can do; draw it there and use its name here`, node.at)
      const def = FUNCTIONS.get(node.name)
      if (!def) return new ExpressionError(`there is no function or distribution ${node.name}${suggest(node.name, [...FUNCTIONS.keys(), ...DISTRIBUTIONS.keys()])}`, node.at)
      if (node.named.some((n) => n !== null)) return new ExpressionError(`${node.name} takes its arguments in order, without names`, node.at)
      const [lo, hi] = def.args
      if (node.args.length < lo || node.args.length > hi) {
        const want = lo === hi ? `${lo}` : hi === Infinity ? `${lo} or more` : `${lo} to ${hi}`
        return new ExpressionError(`${node.name} takes ${want} argument${want === '1' ? '' : 's'}, not ${node.args.length}`, node.at)
      }
      for (const a of node.args) {
        const error = check(a, scope)
        if (error) return error
      }
      return null
    }
  }
}

// A comparison or a condition with NaN stays NaN, so an undefined value is never read as false.
function binary(op: BinOp, a: Fn, b: Fn): Fn {
  switch (op) {
    case '+': return (e) => a(e) + b(e)
    case '-': return (e) => a(e) - b(e)
    case '*': return (e) => a(e) * b(e)
    case '/': return (e) => a(e) / b(e)
    case '^': return (e) => a(e) ** b(e)
    case '<': return (e) => { const x = a(e), y = b(e); return x !== x || y !== y ? NaN : x < y ? 1 : 0 }
    case '<=': return (e) => { const x = a(e), y = b(e); return x !== x || y !== y ? NaN : x <= y ? 1 : 0 }
    case '>': return (e) => { const x = a(e), y = b(e); return x !== x || y !== y ? NaN : x > y ? 1 : 0 }
    case '>=': return (e) => { const x = a(e), y = b(e); return x !== x || y !== y ? NaN : x >= y ? 1 : 0 }
    case '==': return (e) => { const x = a(e), y = b(e); return x !== x || y !== y ? NaN : x === y ? 1 : 0 }
    case '!=': return (e) => { const x = a(e), y = b(e); return x !== x || y !== y ? NaN : x !== y ? 1 : 0 }
    case 'and': return (e) => { const x = a(e); if (x !== x) return NaN; if (x === 0) return 0; const y = b(e); return y !== y ? NaN : y !== 0 ? 1 : 0 }
    case 'or': return (e) => { const x = a(e); if (x !== x) return NaN; if (x !== 0) return 1; const y = b(e); return y !== y ? NaN : y !== 0 ? 1 : 0 }
  }
}

function call(name: string, args: Fn[]): Fn {
  switch (name) {
    case 'if': {
      const [c, yes, no] = args
      return (e) => { const x = c(e); return x !== x ? NaN : x !== 0 ? yes(e) : no(e) }
    }
    case 'pick': {
      const [index, ...values] = args
      return (e) => { const i = Math.round(index(e)); return i >= 1 && i <= values.length ? values[i - 1](e) : NaN }
    }
    case 'min':
      return (e) => { let m = Infinity; for (const f of args) { const v = f(e); if (v !== v) return NaN; if (v < m) m = v } return m }
    case 'max':
      return (e) => { let m = -Infinity; for (const f of args) { const v = f(e); if (v !== v) return NaN; if (v > m) m = v } return m }
  }
  const f = FUNCTIONS.get(name)!.f!
  const [a, b, c] = args
  if (args.length === 1) return (e) => f(a(e), 0, 0)
  if (args.length === 2) return (e) => f(a(e), b(e), 0)
  return (e) => f(a(e), b(e), c(e))
}

/** Compiles a checked tree to a closure that reads its names from their slots in env. */
export function compile(node: Node, slot: (name: string) => number): Fn {
  switch (node.k) {
    case 'num': {
      const v = node.v
      return () => v
    }
    case 'ref': {
      const c = CONSTANTS.get(node.name)
      if (c !== undefined) return () => c
      const i = slot(node.name)
      return (e) => e[i]
    }
    case 'neg': {
      const a = compile(node.a, slot)
      return (e) => -a(e)
    }
    case 'not': {
      const a = compile(node.a, slot)
      return (e) => { const x = a(e); return x !== x ? NaN : x === 0 ? 1 : 0 }
    }
    case 'bin':
      return binary(node.op, compile(node.a, slot), compile(node.b, slot))
    case 'call':
      return call(node.name, node.args.map((x) => compile(x, slot)))
  }
}
