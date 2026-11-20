// Line diffs: which lines two versions of a document share, and the runs that
// changed between them. Used to merge two writers' changes (merge.ts) and to
// show text that arrives from elsewhere as the smallest change to the page.

// Beyond this many cells the line table is not built: the changed middle is
// treated as one change.
const MAX_TABLE = 4_000_000

/** For each line of `a`, the index of the line of `b` it pairs with in a longest common subsequence, or -1. */
export function matchLines(a: string[], b: string[]): Int32Array {
  const out = new Int32Array(a.length).fill(-1)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) { out[start] = start; start++ }
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; out[endA] = endB }
  const rows = endA - start, cols = endB - start
  if (!rows || !cols || rows * cols > MAX_TABLE) return out
  const w = cols + 1
  const table = new Uint32Array((rows + 1) * w)
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * w + j] = a[start + i] === b[start + j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
    }
  }
  let i = 0, j = 0
  while (i < rows && j < cols) {
    if (a[start + i] === b[start + j]) { out[start + i] = start + j; i++; j++ }
    else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++
    else j++
  }
  return out
}

/** Lines [a, aEnd) of the old version became lines [b, bEnd) of the new one. */
export interface Hunk {
  a: number
  aEnd: number
  b: number
  bEnd: number
}

/** The runs of lines that changed, in order. Every line outside them is the same in both versions. */
export function lineHunks(a: string[], b: string[]): Hunk[] {
  const match = matchLines(a, b)
  const hunks: Hunk[] = []
  let i = 0, j = 0
  for (let k = 0; k <= a.length; k++) {
    const end = k === a.length
    if (!end && match[k] < 0) continue
    const at = end ? b.length : match[k]
    if (k > i || at > j) hunks.push({ a: i, aEnd: k, b: j, bEnd: at })
    i = k + 1
    j = at + 1
  }
  return hunks
}
