// Seeded random numbers. Every random quantity draws from a stream of its own, named by what it
// draws, so a draw depends only on the seed, the stream's name and its place in the stream.
// Adding, removing or reordering an input never moves another input's draws, and two
// simulations with one seed share the draws of inputs with the same name: their differences are
// then the model's, not noise (common random numbers).

export interface Stream {
  /** A uniform number in (0, 1), never 0 or 1, from 53 random bits. */
  next(): number
}

const fmix32 = (h: number) => {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** FNV-1a over the label's characters, avalanched. */
function hash(label: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193)
  return fmix32(h)
}

const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k))

/** The stream named `labels` under `seed`: xoshiro128** (period 2¹²⁸ − 1), its state filled by splitmix32. */
export function stream(seed: number, ...labels: (string | number)[]): Stream {
  let key = fmix32((seed >>> 0) ^ 0x6a09e667)
  for (const label of labels) key = fmix32((key ^ hash(String(label))) + 0x9e3779b9)
  const splitmix = () => {
    key = (key + 0x9e3779b9) | 0
    return fmix32(key)
  }
  let a = splitmix()
  let b = splitmix()
  let c = splitmix()
  let d = splitmix()
  if ((a | b | c | d) === 0) a = 1
  const u32 = () => {
    const out = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0
    const t = b << 9
    c ^= a
    d ^= b
    b ^= c
    a ^= d
    c ^= t
    d = rotl(d, 11)
    return out
  }
  return { next: () => ((u32() >>> 5) * 67108864 + (u32() >>> 6) + 0.5) / 9007199254740992 }
}

/** A stable 53-bit fingerprint of text (cyrb53), as hex: the same spec always reads the same. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** JSON with its keys sorted, so equal content always serializes the same. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v)) ?? 'null'
