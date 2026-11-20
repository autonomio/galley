// A work the text names is a work the paper cites. Once review is done, the text is read for every publication,
// standard or dataset it names ("Wilks (1941)", "Pittet et al. (2026)", "JCGM 100:2008") without citing it. Each is
// matched to a work the paper already holds or, where the paper may search beyond its world model, found in the
// scholarly index, and cited where it is named. A name that cannot be found is left as written and goes on the
// sign-off sheet, so nothing stops over it.
import { canarySearch, workFromHit } from '../evidence.js'
import { datasetSources } from '../materials.js'
import type { Paper } from '../paper.js'
import { HOUSE } from '../prompts.js'
import type { Behavior } from '../scheduler.js'
import { arr, int, obj, str } from '../schema.js'
import type { Work } from '../types.js'
import { onlyWorldModel } from '../worldmodel.js'
import { reviewDone } from './close.js'
import { keyFor, live, seatFamily, sectionText } from './common.js'
import { setPassage } from './write.js'

export interface Named { section: string; quote: string; authors: string[]; year: number | null; title: string }

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const words = (text: string) => new Set(fold(text).split(/[^a-z0-9]+/).filter((w) => w.length > 3))
/** How much of the shorter title the other one shares, word by word. */
const overlap = (a: string, b: string) => {
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return 0
  let n = 0
  for (const w of x) if (y.has(w)) n++
  return n / Math.min(x.size, y.size)
}

/** The one work a name points to: by its first author and year, and its title where the name gives one. Null when none or several fit. */
export function matchNamed(named: Named, works: Work[]): Work | null {
  const first = named.authors[0] ? fold(named.authors[0]).trim() : ''
  const byAuthor = (w: Work) => !!w.authors[0] && new RegExp(`(^|[^a-z])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(fold(w.authors[0]))
  const fits = works.filter((w) => {
    if (named.year && w.year && Math.abs(w.year - named.year) > 1) return false
    if (first) return byAuthor(w)
    return !!named.title && overlap(named.title, w.title) >= 0.6
  })
  if (fits.length <= 1) return fits[0] ?? null
  const sameYear = fits.filter((w) => w.year === named.year)
  if (sameYear.length === 1) return sameYear[0]
  if (!named.title) return null
  const ranked = (sameYear.length ? sameYear : fits).map((w) => ({ w, score: overlap(named.title, w.title) })).sort((a, b) => b.score - a.score)
  return ranked[0].score >= 0.5 && ranked[0].score > (ranked[1]?.score ?? 0) ? ranked[0].w : null
}

/**
 * The text with the work cited where the quote names it:
 * - A reference in parentheses of its own, "(Wilks, 1941)" or "(Dvoretzky, Kiefer and Wolfowitz, 1956, Ann. Math.
 *   Stat. 27(3), 642–669)", becomes the citation, "[@key]": the reference list gives the rest.
 * - A name that ends with its year in parentheses keeps its words, and the year becomes the citation ("Wilks (1941)" →
 *   "Wilks [-@key]", printed "Wilks (1941)").
 * - Any other name is followed by one ("JCGM 100:2008 [@key]").
 * Null when the quote is not in the text.
 */
export function citeAt(text: string, quote: string, key: string, surname = ''): string | null {
  const at = text.indexOf(quote)
  if (!quote || at < 0) return null
  const own = ownParentheses(text, at, quote)
  if (own) return `${text.slice(0, own.start)}[@${key}]${text.slice(own.end)}`
  // A parenthesis that opens inside the name: "Wilks (1941)" keeps the name and its year becomes the citation;
  // "SSR (Pittet et al. 2026, October manuscript)" holds the reference itself, which becomes the citation.
  const open = quote.lastIndexOf('(')
  if (open >= 0) {
    const start = at + open
    const end = closing(text, start)
    const inner = end > 0 ? text.slice(start + 1, end) : ''
    if (end > 0 && end - start < 140 && !inner.includes(';') && /\b\d{4}[a-z]?\b/.test(inner)) {
      const withAuthor = !!surname && fold(inner).includes(fold(surname))
      return `${text.slice(0, start).trimEnd()} ${withAuthor ? `[@${key}]` : `[-@${key}]`}${text.slice(end + 1)}`
    }
  }
  return `${text.slice(0, at)}${quote} [@${key}]${text.slice(at + quote.length)}`
}

/** Where the parenthesis that opens at start closes, or -1. */
function closing(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  return -1
}

/** The parentheses a reference stands in alone, with at most its own bibliographic details after it; null otherwise. */
function ownParentheses(text: string, at: number, quote: string): { start: number; end: number } | null {
  if (quote.startsWith('(') && closing(text, at) === at + quote.length - 1) return { start: at, end: at + quote.length }
  const open = text.slice(0, at).search(/\(\s*$/)
  if (open < 0) return null
  const end = closing(text, open)
  if (end < 0) return null
  // Never a second reference or a remark: those stay, and the name is cited where it stands.
  const tail = text.slice(at + quote.length, end)
  return tail.length > 90 || tail.includes(';') || /\b(see|also|e\.g\.|cf\.|and|for)\b/i.test(tail) ? null : { start: open, end: end + 1 }
}

export const citeNamed: Behavior = {
  id: 'cite-named', stage: 'close', improver: true, title: 'Cite every work the text names',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.outline || s.outcome || paper.isSettled('frame:final') || !reviewDone(paper)) return []
    return [{
      key: 'named:works', label: 'every work the text names, cited where it is named',
      run: async () => {
        const sections = s.outline!.sections
        const checker = seatFamily(paper, 'checker')
        const reply = await paper.ask<any>({
          behavior: 'cite-named', target: 'works', seat: 'checker', family: checker,
          prompt: `${HOUSE}

Below is a manuscript, section by section; a citation in it is written [@key], [-@key] or @key. List every place where the text names a specific publication, standard or dataset without citing it right there: an author and year such as "Wilks (1941)", "Dvoretzky, Kiefer and Wolfowitz (1956)" or "Pittet et al. (2026)", or a document's own designation such as "JCGM 100:2008". Leave out a method or result named after people that points to no publication (such as "the Kaplan–Meier estimator"), and anything a citation already follows.
For each: section (its id in brackets), quote (the words that name it, copied character for character from the text, ending with the year in parentheses where the text gives one), authors (surnames, in order, as far as the text or your knowledge gives them), year (0 if none), title (the work's title if you know it with confidence, else empty).

${sections.map((sec) => `[${sec.id}] ${sec.title}\n${sectionText(paper, sec.id)}`).join('\n\n')}`,
          schema: obj({ named: arr(obj({ section: str(), quote: str(), authors: arr(str()), year: int(), title: str() })) }),
        })
        const named: Named[] = (reply.named ?? [])
          .map((n: any) => ({ section: String(n.section ?? '').replace(/[[\]]/g, ''), quote: String(n.quote ?? ''), authors: (n.authors ?? []).map(String).filter(Boolean), year: Number(n.year) || null, title: String(n.title ?? '') }))
          .filter((n: Named) => n.quote && sections.some((sec) => sec.id === n.section))
        const found = new Map<Named, Work>()
        for (const n of named) {
          const work = matchNamed(n, Object.values(s.works))
          if (work) found.set(n, work)
        }
        // Beyond the works it holds, a paper looks only where it may: never past a world model it rests on alone.
        const missing = named.filter((n) => !found.has(n))
        if (missing.length && !onlyWorldModel(paper) && !paper.config.off.includes('find-evidence')) {
          const queries = missing.map((n, i) => ({ id: `N${i + 1}`, search: n.title || `${n.authors.join(' ')} ${n.year ?? ''}`.trim() }))
          try {
            const results = await canarySearch(paper.path('canary', 'named'), `galley:${s.slug}:named`, queries, 8)
            missing.forEach((n, i) => {
              const work = matchNamed(n, (results[`N${i + 1}`]?.results ?? []).map(workFromHit))
              if (!work) return
              s.works[work.id] = s.works[work.id] ?? work
              found.set(n, s.works[work.id])
            })
          } catch (error) {
            paper.note('cite-named', `The scholarly index could not be searched for the works the text names: ${(error as Error).message.slice(0, 200)}`)
          }
        }
        const by = { kind: 'agent' as const, family: checker, model: paper.config.models[checker]?.model ?? checker, seat: 'checker' as const, behavior: 'cite-named' }
        // A work is cited once in a section, at its first mention, and not at all where the section cites it already;
        // a dataset is cited where it is described, not wherever its name recurs.
        const datasets = new Set((paper.config.datasets ?? []).flatMap((unit) => Object.values(datasetSources(paper, unit))))
        const cited: NonNullable<typeof s.named> = []
        for (const [n, work] of found) {
          if (datasets.has(work.id)) continue
          const key = keyFor(paper, work)
          const text = sectionText(paper, n.section)
          if (text.includes(`@${key}`) || cited.some((c) => c.workId === work.id && c.sectionId === n.section && c.placed)) continue
          const next = citeAt(text, n.quote, key, n.authors[0] ?? '')
          if (next) setPassage(paper, n.section, next, by, `cited ${key} where the text names it`)
          cited.push({ workId: work.id, quote: n.quote, sectionId: n.section, placed: !!next })
        }
        s.named = [...(s.named ?? []), ...cited]
        s.unreferenced = named.filter((n) => !found.has(n)).map((n) => ({ quote: n.quote, sectionId: n.section }))
        paper.journal({ event: 'cite_named', named: named.length, cited: cited.length, unreferenced: s.unreferenced.length })
        if (named.length) paper.note('cite-named', `${cited.length} of ${named.length} works the text names are now cited${s.unreferenced.length ? `; not found: ${s.unreferenced.map((u) => u.quote).join('; ')}` : ''}.`)
        paper.save()
      },
      // An improvement pass: if it cannot run, the text stands as written and the proof reading still sees it.
      skip: () => {},
    }]
  },
}
