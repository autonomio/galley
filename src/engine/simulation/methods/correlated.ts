// Correlated Monte Carlo: a Gaussian copula. Each correlated input's own uniform becomes a normal
// score, a Cholesky factor mixes the scores, and each mixed score goes back through Φ and the
// input's own quantile function. The dependence changes; no input's distribution does. A spec
// states rank (Spearman) correlations, which do not depend on the inputs' distributions, so the
// stated value is what a run recovers whatever the marginals.
import { normalCdf, normalQuantile } from '../special.js'
import { rankCorrelation } from '../stats.js'
import type { Check, Method } from '../types.js'
import { drawCount, inputStream, noSequence, runDraws } from './monte-carlo.js'

type Matrix = number[][]

const identity = (n: number): Matrix => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))

/** The lower Cholesky factor, or null when the matrix is not positive definite. */
export function cholesky(a: Matrix): Matrix | null {
  const n = a.length
  const l: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i][j]
      for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k]
      if (i === j) {
        if (!(s > 1e-12)) return null
        l[i][i] = Math.sqrt(s)
      } else l[i][j] = s / l[j][j]
    }
  }
  return l
}

/** Eigenvalues and eigenvectors (as columns) of a symmetric matrix, by cyclic Jacobi rotations. */
function eigen(m: Matrix): { values: number[]; vectors: Matrix } {
  const n = m.length
  const a = m.map((row) => [...row])
  const v = identity(n)
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2
    if (off < 1e-22) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v }
}

/** V diag(max(λ, floor)) Vᵀ: the nearest matrix (in the Frobenius norm) with eigenvalues at least floor. */
function clipped(m: Matrix, floor: number): Matrix {
  const { values, vectors } = eigen(m)
  const n = m.length
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    let s = 0
    for (let k = 0; k < n; k++) s += vectors[i][k] * Math.max(values[k], floor) * vectors[j][k]
    return s
  }))
}

/**
 * The nearest correlation matrix: Higham's (2002) alternating projections with Dykstra's
 * correction, then a last clip that keeps it strictly positive definite, rescaled to a unit diagonal.
 */
export function nearestCorrelation(a: Matrix): Matrix {
  const n = a.length
  let y = a.map((row) => [...row])
  let correction: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let iteration = 0; iteration < 500; iteration++) {
    const r = y.map((row, i) => row.map((v, j) => v - correction[i][j]))
    const x = clipped(r, 0)
    correction = x.map((row, i) => row.map((v, j) => v - r[i][j]))
    const next = x.map((row, i) => row.map((v, j) => (i === j ? 1 : v)))
    let change = 0
    let size = 0
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { change += (next[i][j] - y[i][j]) ** 2; size += next[i][j] ** 2 }
    y = next
    if (change <= 1e-24 * size) break
  }
  const pd = clipped(y, 1e-6)
  return pd.map((row, i) => row.map((v, j) => v / Math.sqrt(pd[i][i] * pd[j][j])))
}

// A Gaussian copula with normal-score correlation r has rank correlation (6/π) asin(r/2).
const toNormal = (rho: number) => 2 * Math.sin((Math.PI * rho) / 6)
const toRank = (r: number) => (6 / Math.PI) * Math.asin(r / 2)

interface Plan {
  draws: number
  /** Inputs in the copula, by their index in the model's inputs. */
  members: number[]
  factor: Matrix
  pairs: { a: string; b: string; target: number; used: number }[]
}

const U_MIN = 2 ** -53

export const correlated: Method<Plan> = {
  name: 'correlated',
  about: 'inputs drawn together through a Gaussian copula with the stated rank correlations, each keeping its own distribution',
  prepare(spec, model, problems, notes) {
    noSequence(spec, 'correlated', problems)
    const draws = drawCount(spec, notes)
    const index = new Map(model.inputs.map((x, i) => [x.name, i]))
    const pairs: { a: string; b: string; rho: number }[] = []
    const seen = new Set<string>()
    for (const [i, c] of spec.correlations.entries()) {
      const at = `correlations[${i}]`
      const issue = [c.a, c.b].map((name) => {
        if (!spec.inputs.some((x) => x.name === name)) return `${name} is not an input`
        const k = index.get(name)
        return k !== undefined && !model.inputs[k].draw ? `${name} has a fixed value, so nothing about it can vary with another input` : null
      }).find(Boolean)
      if (issue) { problems.push({ at, message: issue }); continue }
      if (!index.has(c.a) || !index.has(c.b)) continue
      if (c.a === c.b) { problems.push({ at, message: `an input cannot be correlated with itself (${c.a})` }); continue }
      if (!(c.rho >= -1 && c.rho <= 1)) { problems.push({ at, message: `rho must be between -1 and 1, not ${c.rho}` }); continue }
      const key = [c.a, c.b].sort().join('\u0000')
      if (seen.has(key)) { problems.push({ at, message: `the correlation of ${c.a} and ${c.b} is given twice` }); continue }
      seen.add(key)
      pairs.push(c)
    }
    const members = [...new Set(pairs.flatMap((p) => [index.get(p.a)!, index.get(p.b)!]))].sort((x, y) => x - y)
    const position = new Map(members.map((m, i) => [model.inputs[m].name, i]))
    const target = identity(members.length)
    for (const p of pairs) {
      const [i, j] = [position.get(p.a)!, position.get(p.b)!]
      target[i][j] = target[j][i] = toNormal(p.rho)
    }
    let factor = cholesky(target)
    let used = target
    if (!factor && members.length) {
      // Correlations that cannot hold together: run with the nearest set that can, and say how far it moved.
      used = nearestCorrelation(target)
      factor = cholesky(used)!
      const moved = pairs.map((p) => Math.abs(toRank(used[position.get(p.a)!][position.get(p.b)!]) - p.rho))
      notes.push({ name: 'correlations', ok: false, detail: `the stated correlations cannot hold together; the run used the nearest set that can, which moves a stated correlation by up to ${Math.max(...moved).toFixed(3)}` })
    }
    if (!spec.correlations.length) notes.push({ name: 'correlations', ok: true, detail: 'no correlations are stated, so every input is drawn on its own' })
    return {
      draws,
      members,
      factor: factor ?? [],
      pairs: pairs.map((p) => ({ a: p.a, b: p.b, target: p.rho, used: used === target ? p.rho : toRank(used[position.get(p.a)!][position.get(p.b)!]) })),
    }
  },
  run(plan, model, ctx) {
    const inCopula = new Set(plan.members)
    const lone = model.inputs.map((x, i) => ({ x, i })).filter(({ x, i }) => x.draw && !inCopula.has(i))
      .map(({ x }) => ({ slot: x.slot, dist: x.draw!.dist, args: x.args, n: x.args.length, stream: inputStream(ctx, x.name) }))
    const members = plan.members.map((i) => {
      const x = model.inputs[i]
      return { slot: x.slot, dist: x.draw!.dist, args: x.args, n: x.args.length, stream: inputStream(ctx, x.name), values: new Float64Array(plan.draws) }
    })
    const k = members.length
    const z = new Float64Array(k)
    const L = plan.factor
    let row = 0
    const sample = runDraws(plan.draws, model, (env) => {
      for (const r of lone) env[r.slot] = r.dist.quantile(r.stream.next(), r.args, r.n)
      for (let j = 0; j < k; j++) z[j] = normalQuantile(members[j].stream.next())
      for (let j = 0; j < k; j++) {
        let y = 0
        for (let m = 0; m <= j; m++) y += L[j][m] * z[m]
        // Φ of a score beyond eight sd rounds to 0 or 1, where an unbounded quantile is infinite.
        const u = Math.min(1 - U_MIN, Math.max(U_MIN, normalCdf(y)))
        const member = members[j]
        const v = member.dist.quantile(u, member.args, member.n)
        env[member.slot] = v
        member.values[row] = v
      }
      row++
    })
    const byName = new Map(plan.members.map((i, j) => [model.inputs[i].name, members[j].values]))
    const checks: Check[] = []
    const achieved = plan.pairs.map((p) => {
      const value = rankCorrelation(byName.get(p.a)!, byName.get(p.b)!)
      const discrete = [p.a, p.b].filter((n) => model.inputs.find((x) => x.name === n)!.draw!.dist.discrete)
      const ok = Math.abs(value - p.used) <= 0.03
      checks.push({
        name: `correlation of ${p.a} and ${p.b}`, ok,
        detail: `rank correlation ${value.toFixed(3)} for a stated ${p.target.toFixed(3)}${p.used !== p.target ? ` (${p.used.toFixed(3)} after the repair)` : ''}${!ok && discrete.length ? `; ties in ${discrete.join(' and ')}, which ${discrete.length > 1 ? 'are' : 'is'} discrete, weaken a rank correlation` : ''}`,
      })
      return { ...p, achieved: value }
    })
    return { replicates: [sample], size: { draws: plan.draws, replicates: 1 }, diagnostics: { correlations: achieved }, checks }
  },
}
