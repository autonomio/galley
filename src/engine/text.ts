// Small text rules shared by behaviors and rendering: exact edits, verbatim
// checks, citation keys. Pure, so the tests can hold them.
import type { Work } from './types.js'

export const squash = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()

/** How printed text names a paper's authors: one author is "the author", never "the authors". */
export function authorsNamed(count: number, possessive = false): string {
  const many = count > 1
  return possessive ? (many ? 'the authors’' : 'the author’s') : (many ? 'the authors' : 'the author')
}

/** Whether `passage` appears in `source`, ignoring whitespace and quote styles. */
export function isVerbatim(passage: string, source: string): boolean {
  const p = squash(passage)
  return p.length >= 12 && squash(source).includes(p)
}

export interface Edit {
  old: string
  new: string
}

/** Apply an exact edit only when its old text occurs exactly once. */
export function applyExact(text: string, edit: Edit): string | null {
  if (!edit.old) return null
  const first = text.indexOf(edit.old)
  if (first < 0 || text.indexOf(edit.old, first + 1) >= 0) {
    // Tolerate a quote that differs only in whitespace, when that is still unique (and short enough to match that way).
    if (edit.old.length > 2000) return null
    const pattern = edit.old.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('\\s+')
    if (!pattern) return null
    let matches: RegExpMatchArray[]
    try { matches = [...text.matchAll(new RegExp(pattern, 'g'))] } catch { return null }
    if (matches.length !== 1) return null
    const at = matches[0].index!
    return text.slice(0, at) + edit.new + text.slice(at + matches[0][0].length)
  }
  return text.slice(0, first) + edit.new + text.slice(first + edit.old.length)
}

const STOP = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'and', 'for', 'to', 'from', 'with', 'is', 'are', 'how', 'why', 'what', 'do', 'does'])

function ascii(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

/** Words that make a name an organization's, whose comma does not put a family name first ("University of California, Berkeley"). */
const ORGANIZATION_WORD = /\b(universit|institut|laborator|department|school|college|cent(er|re)|academy|ministry|council|society|association|company|corporation|inc\b|ltd\b|gmbh)/i

/**
 * The people a work's index record names, one each and given name first. An index can list them in one string with
 * their affiliations in brackets ("Lundstrom, Blake R [NREL]; Patel, Sourav [University of Minnesota]"), or one with
 * the family name first ("Linder, Andreas"): they come back as "Blake R Lundstrom", "Sourav Patel", "Andreas Linder".
 */
export function personNames(names: string[]): string[] {
  return names.flatMap((name) => String(name ?? '').split(/\s*;\s*/))
    .map((name) => name.replace(/\[[^\]]*(?:\]|$)/g, ' ').replace(/\s+/g, ' ').trim().replace(/[,;]+$/, '').trim())
    .filter(Boolean)
    .map((name) => {
      const m = name.match(/^([^,]+),\s*([^,]+)$/)
      return m && !ORGANIZATION_WORD.test(name) ? `${m[2].trim()} ${m[1].trim()}` : name
    })
}

/** A readable, stable citation key: firstauthor + year + first title word. */
export function citationKey(work: Work, taken: Set<string>): string {
  const first = personNames(work.authors)[0] ?? 'anon'
  const family = ascii(first.trim().split(/\s+/).pop() ?? 'anon') || 'anon'
  const word = (work.title.split(/\s+/).map(ascii).find((w) => w.length > 2 && !STOP.has(w)) ?? 'work').slice(0, 12)
  const base = `${family}${work.year ?? 'nd'}${word}`
  let key = base
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`
  taken.add(key)
  return key
}

/** Author-year label for prompts: "Uzzi et al. 2013". */
export function authorYear(work: Work): string {
  const last = (name: string) => name.trim().split(/\s+/).pop() ?? name
  const names = work.authors.length === 0 ? 'Anon.' : work.authors.length === 1 ? last(work.authors[0])
    : work.authors.length === 2 ? `${last(work.authors[0])} and ${last(work.authors[1])}` : `${last(work.authors[0])} et al.`
  return `${names} ${work.year ?? 'n.d.'}`
}

/** Citation keys used in a passage of Pandoc markdown. */
export function citedKeys(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/@([A-Za-z0-9_][A-Za-z0-9_:.#$%&\-+?<>~/]*)/g)].map((m) => m[1].replace(/[.:;,]+$/, '')))]
}

/** Remove citations to keys that are not in the bibliography, keeping the prose intact. */
export function dropUnknownCitations(markdown: string, known: Set<string>): { text: string; dropped: string[] } {
  const dropped: string[] = []
  const text = markdown
    .replace(/\[([^\]]*@[^\]]*)\]/g, (whole, inner: string) => {
      const parts = inner.split(';').map((p) => p.trim()).filter((part) => {
        const key = part.match(/@([A-Za-z0-9_][A-Za-z0-9_:.#$%&\-+?<>~/]*)/)?.[1]?.replace(/[.:;,]+$/, '')
        if (!key) return true
        if (known.has(key)) return true
        dropped.push(key)
        return false
      })
      return parts.length ? `[${parts.join('; ')}]` : ''
    })
    .replace(/(^|[\s(])@([A-Za-z0-9_][A-Za-z0-9_:.#$%&\-+?<>~/]*)/g, (whole, pre: string, key: string) => {
      const clean = key.replace(/[.:;,]+$/, '')
      if (known.has(clean)) return whole
      dropped.push(clean)
      return pre + 'prior work'
    })
    .replace(/ +([.,;:])/g, '$1')
  return { text, dropped }
}

export const words = (text: string) => text.split(/\s+/).filter(Boolean).length

/**
 * Print every @word that is not a known citation key as text (outside code):
 * pandoc reads "@humans" or "@scope/package" as a citation, and a citation to
 * nothing breaks the PDF.
 */
export function escapeUnknownCitations(markdown: string, known: Set<string>): string {
  return markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => i % 2 ? part
    : part.replace(/(^|[^\w\\])@([A-Za-z0-9_][A-Za-z0-9_:.#$%&\-+?<>~/]*)/g, (whole, pre: string, key: string) => known.has(key.replace(/[.:;,]+$/, '')) ? whole : `${pre}\\@${key}`)).join('')
}

const COMMON = new Set([...STOP, 'that', 'this', 'these', 'those', 'by', 'as', 'at', 'be', 'it', 'its', 'or', 'not', 'their', 'than', 'which', 'can', 'more', 'most', 'into', 'over', 'such', 'they', 'was', 'were', 'has', 'have', 'been', 'also', 'only', 'when', 'where', 'who'])

/** The words that carry a sentence's content: lower case, no punctuation, no function words. */
export function contentWords(text: string): Set<string> {
  const plain = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ')
  return new Set(plain.split(' ').filter((w) => w.length > 2 && !COMMON.has(w)))
}

/** The share of `a`'s content words that also occur in `b`. */
export function overlap(a: string, b: string): number {
  const wa = contentWords(a)
  if (!wa.size) return 0
  const wb = contentWords(b)
  return [...wa].filter((w) => wb.has(w)).length / wa.size
}

/** Two claims ask for the same thing when the shorter one's content is almost all in the longer. */
export function sameClaim(a: string, b: string): boolean {
  return contentWords(a).size <= contentWords(b).size ? overlap(a, b) >= 0.85 : overlap(b, a) >= 0.85
}
