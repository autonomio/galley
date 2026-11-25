// Three-way merges, for when two writers changed one document from the same
// starting point: a person in the editor and an agent writing from a paper run,
// or two tabs. A change made on one side only is taken from that side. Where
// both sides changed the same lines (or the same field of a note), the local
// side stands and the overlap is counted, so a person's words are never lost
// to a write they did not see.
import type { Annotation, AnnotationReply } from '../types.js'
import { matchLines } from './diff.js'

export interface MergeResult {
  text: string
  /** Places where both sides changed the same lines; the local side was kept. */
  conflicts: number
}

const sameLines = (x: string[], y: string[]) => x.length === y.length && x.every((line, i) => line === y[i])

/** Merge `ours` and `theirs`, both edited from `base`, line by line. */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs || theirs === base) return { text: ours, conflicts: 0 }
  if (ours === base) return { text: theirs, conflicts: 0 }
  const B = base.split('\n'), O = ours.split('\n'), T = theirs.split('\n')
  const po = matchLines(B, O), pt = matchLines(B, T)
  const out: string[] = []
  let conflicts = 0
  let b = 0, o = 0, t = 0
  // A base line kept by both sides is a fixed point; between fixed points each
  // side either left the base alone, or changed it.
  for (let i = 0; i <= B.length; i++) {
    const end = i === B.length
    if (!end && !(po[i] >= o && pt[i] >= t)) continue
    const oEnd = end ? O.length : po[i], tEnd = end ? T.length : pt[i]
    const bc = B.slice(b, i), oc = O.slice(o, oEnd), tc = T.slice(t, tEnd)
    if (sameLines(oc, bc)) out.push(...tc)
    else if (sameLines(tc, bc) || sameLines(oc, tc)) out.push(...oc)
    else if (bc.length === oc.length && bc.length === tc.length) {
      // Neighbouring lines changed on different sides, with no untouched line
      // between them: still two separate changes, merged line by line.
      for (let k = 0; k < bc.length; k++) {
        if (oc[k] === bc[k]) out.push(tc[k])
        else if (tc[k] === bc[k] || tc[k] === oc[k]) out.push(oc[k])
        else { out.push(oc[k]); conflicts++ }
      }
    } else { out.push(...oc); conflicts++ }
    if (!end) out.push(B[i])
    b = i + 1; o = oEnd + 1; t = tEnd + 1
  }
  return { text: out.join('\n'), conflicts }
}

const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null)

function mergeReplies(base: AnnotationReply[] = [], ours: AnnotationReply[] = [], theirs: AnnotationReply[] = []): AnnotationReply[] {
  const before = new Map(base.map((r) => [r.id, r]))
  const mine = new Map(ours.map((r) => [r.id, r]))
  const out: AnnotationReply[] = []
  for (const r of theirs) {
    const local = mine.get(r.id)
    // A reply deleted here, and untouched there, stays deleted.
    if (!local && before.has(r.id) && same(before.get(r.id), r)) continue
    out.push(local && !same(local, before.get(r.id)) ? local : r)
  }
  const seen = new Set(out.map((r) => r.id))
  for (const r of ours) if (!seen.has(r.id) && !(before.has(r.id) && !theirs.some((x) => x.id === r.id) && same(before.get(r.id), r))) out.push(r)
  return out
}

function mergeNote(base: Annotation | undefined, ours: Annotation, theirs: Annotation): { note: Annotation, conflicts: number } {
  let conflicts = 0
  const note: Annotation = { ...theirs }
  for (const key of ['comment', 'range', 'snippet', 'resolved', 'labels', 'author'] as const) {
    const changedHere = !base || !same(ours[key], base[key])
    const changedThere = !base || !same(theirs[key], base[key])
    if (changedHere && changedThere && !same(ours[key], theirs[key])) conflicts++
    if (changedHere) (note as unknown as Record<string, unknown>)[key] = ours[key]
  }
  if (ours.replies || theirs.replies) note.replies = mergeReplies(base?.replies, ours.replies, theirs.replies)
  note.updated_at = ours.updated_at > theirs.updated_at ? ours.updated_at : theirs.updated_at
  return { note, conflicts }
}

/** Merge two edited lists of notes, matched by id. */
export function mergeAnnotations(base: Annotation[], ours: Annotation[], theirs: Annotation[]): { annotations: Annotation[], conflicts: number } {
  const B = new Map(base.map((a) => [a.id, a]))
  const O = new Map(ours.map((a) => [a.id, a]))
  const T = new Map(theirs.map((a) => [a.id, a]))
  const out: Annotation[] = []
  let conflicts = 0
  const ids = [...ours.map((a) => a.id), ...theirs.map((a) => a.id).filter((id) => !O.has(id))]
  for (const id of ids) {
    const b = B.get(id), o = O.get(id), t = T.get(id)
    if (o && t) {
      if (same(o, b)) out.push(t)
      else if (same(t, b)) out.push(o)
      else { const m = mergeNote(b, o, t); out.push(m.note); conflicts += m.conflicts }
    } else if (o) {
      // Deleted there: gone, unless it was changed here since.
      if (!b || !same(o, b)) out.push(o)
    } else if (t) {
      if (!b || !same(t, b)) out.push(t)
    }
  }
  return { annotations: out, conflicts }
}
