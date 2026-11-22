// Every paper at a glance, for whatever shows them all at once: what
// /api/galley-live says about each, and the words it is shown in. Read from
// the papers' own files by the server; nothing here touches a run.

export interface Working { seat: string, name: string, family: string | null, model: string, doing: string, section: string | null, finding: string | null, seconds: number }
export interface Glance {
  slug: string
  doc: string
  title: string
  /** A paper, or a thesis handed back as a brief. */
  mode: 'paper' | 'thesis'
  running: boolean
  outcome: string | null
  /** Finished: a paper ready for submission, or a thesis whose brief is written. */
  ready: boolean
  stage: { id: string, label: string }
  stages: { id: string, label: string, done: boolean }[]
  team: { seat: string, name: string, family: string | null, detail: string | null }[]
  now: Working[]
  waiting: { name: string, until: string } | null
  updated: string | null
  started: string | null
  progress: {
    sections: { written: number, total: number } | null
    review: { round: number, rounds: number, findings: number, open: number } | null
  }
  /** Whether the paper's document is in this editor, and whether it has a PDF yet: the ways into it. */
  document: boolean
  pdf: boolean
}
export type GlanceState = 'running' | 'waiting' | 'stopped' | 'ready'

export const STATE_LABEL: Record<GlanceState, string> = { running: 'Writing', waiting: 'Waiting', stopped: 'Stopped', ready: 'Ready' }

export async function fetchPapers(): Promise<Glance[]> {
  const res = await fetch('/api/galley-live', { cache: 'no-store' })
  if (!res.ok) throw new Error(`the papers could not be read (${res.status})`)
  return ((await res.json()) as { papers: Glance[] }).papers
}

export const stateOf = (p: Glance): GlanceState => (p.ready ? 'ready' : !p.running ? 'stopped' : p.waiting ? 'waiting' : 'running')

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** How long ago, in the fewest words that still say it: 12 s, 4 min, 2 h 5 min, 3 days. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'not yet'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`
  return plural(Math.floor(s / 86_400), 'day') + ' ago'
}

export const elapsed = (seconds: number) => (seconds < 60 ? `${seconds} s` : seconds < 3600 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`)

/** Who is at work, one line a seat: what it has been doing longest, and how many it is doing at once. */
export function working(p: Glance): (Working & { count: number })[] {
  const bySeat = new Map<string, Working[]>()
  for (const n of p.now) bySeat.set(n.seat, [...(bySeat.get(n.seat) ?? []), n])
  return [...bySeat.values()].map((list) => ({ ...list.reduce((a, b) => (b.seconds > a.seconds ? b : a)), count: list.length }))
}

/** What there is to say when no one is at work. */
export function quiet(p: Glance): string {
  const state = stateOf(p)
  if (state === 'ready') return p.mode === 'thesis' ? `The brief is in the document${p.pdf ? ', with a PDF beside it' : ''}.` : 'Ready for submission. The sign-off is yours.'
  if (state === 'stopped') return 'The run has stopped; run it again to resume.'
  if (state === 'waiting') return `Waiting for ${p.waiting!.name} until ${new Date(p.waiting!.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
  return 'Between steps.'
}

/** How far it has come, in the words the working notes use. */
export function progressWords(p: Glance): { sections: string | null, round: string | null, findings: string | null } {
  const { sections, review } = p.progress
  return {
    sections: sections ? `${sections.written} of ${plural(sections.total, 'section')} written` : null,
    round: review ? `Round ${review.round} of ${review.rounds}` : null,
    findings: review ? `${review.open} of ${plural(review.findings, 'finding')} open` : null,
  }
}

/** Where the paper opens: its document with Activity beside it, or, when its document is not here, its PDF. */
export function entry(p: Glance, search = location.search): { href: string, label: string, external: boolean } | null {
  const keep = new URLSearchParams(search)
  keep.delete('doc')
  keep.delete('view')
  const rest = keep.toString()
  if (p.document) return { href: `/?doc=${encodeURIComponent(p.doc)}&view=activity${rest ? `&${rest}` : ''}`, label: 'Open', external: false }
  if (p.pdf) return { href: `/papers/${encodeURIComponent(p.doc)}/${p.mode === 'thesis' ? 'thesis' : 'paper'}.pdf`, label: 'Open the PDF', external: true }
  return null
}
