// Every paper in the document picker, the list a writer already opens to
// switch between papers: under each paper's name, whether it is being written
// and its stage, its review round, open findings and sections, how long since
// it changed, and who is at work on what. A paper whose document is not in
// this editor is at the picker's foot, with the way into it. Nothing new to
// open: picking a paper is the way into it, as it always was.
import type { EditorPlugin } from '../src/index.js'
import { ago, elapsed, entry, fetchPapers, progressWords, quiet, stateOf, working, type Glance } from './glance.js'
import { esc, faceHTML, setText } from './living.js'

const POLL_MS = 4000

const words = (p: Glance) => {
  const w = progressWords(p)
  const { sections } = p.progress
  return [w.round, w.findings, sections ? `${sections.written}/${sections.total} sections` : null].filter(Boolean).join(' · ')
}
const stateWords = (p: Glance) => {
  const state = stateOf(p)
  return state === 'ready' ? 'Ready for submission' : `${state === 'running' ? 'Writing' : state === 'waiting' ? 'Waiting' : 'Stopped'} · ${p.stage.label}`
}

/** Seats doing the same thing read as one: "Methods, Field and Editor referees reviewing the whole manuscript". */
function together(names: string[]): string {
  if (names.length === 1) return names[0]
  const referees = names.every((n) => n.endsWith(' referee'))
  const bare = referees ? names.map((n) => n.replace(/ referee$/, '')) : names
  const list = `${bare.slice(0, -1).join(', ')} and ${bare.at(-1)}`
  return referees ? `${list} referees` : list
}

export function papersInPicker(): EditorPlugin {
  return (editor) => {
    let papers: Glance[] = []
    let fetchedAt = Date.now()
    let timer = 0
    let clock = 0
    let done = false

    function line(slot: HTMLElement): HTMLElement {
      if (!slot.firstElementChild) slot.innerHTML = '<span class="pp-head"><span class="pp-state"><i class="pp-dot" aria-hidden="true"></i><b></b></span><time class="pp-ago"></time></span><span class="pp-words"></span><span class="pp-now"></span>'
      return slot
    }

    function fill(slot: HTMLElement, p: Glance, now: number): void {
      line(slot)
      const state = stateOf(p)
      slot.dataset.state = state
      setText(slot.querySelector('.pp-state b')!, stateWords(p))
      setText(slot.querySelector('.pp-words')!, words(p))
      setText(slot.querySelector('.pp-ago')!, `changed ${ago(p.updated, now)}`)
      // Who is at work, as groups of seats doing the same thing; redrawn only when that changes.
      const since = Math.round((now - fetchedAt) / 1000)
      const groups = new Map<string, ReturnType<typeof working>>()
      if (state === 'running') for (const w of working(p)) groups.set(w.doing, [...(groups.get(w.doing) ?? []), w])
      const html = groups.size
        ? [...groups.values()].map((g) => {
          const longest = Math.max(...g.map((w) => w.seconds))
          const many = g.reduce((n, w) => n + w.count, 0)
          return `<span class="pp-work"><span class="pp-faces">${g.map((w) => faceHTML(w.seat, w.family)).join('')}</span><span class="pp-doing"><b>${esc(together(g.map((w) => w.name)))}</b> ${esc(g[0].doing)}</span><time>${elapsed(longest + since)}${many > g.length ? ` · ${many} at once` : ''}</time></span>`
        }).join('')
        : `<span class="pp-quiet">${esc(quiet(p))}</span>`
      const nowEl = slot.querySelector<HTMLElement>('.pp-now')!
      const key = `${html.replace(/<time>[^<]*<\/time>/g, '')}`
      if (nowEl.dataset.key !== key) { nowEl.dataset.key = key; nowEl.innerHTML = html }
      else nowEl.querySelectorAll('time').forEach((t, i) => {
        const g = [...groups.values()][i]
        if (!g) return
        const many = g.reduce((n, w) => n + w.count, 0)
        setText(t, `${elapsed(Math.max(...g.map((w) => w.seconds)) + since)}${many > g.length ? ` · ${many} at once` : ''}`)
      })
    }

    function draw(now = Date.now()): void {
      for (const p of papers) if (p.document) fill(editor.slot('document', p.doc), p, now)
      // Papers whose document is not here: at the foot, each opening where it can.
      const away = papers.filter((p) => !p.document)
      const foot = editor.slot('picker')
      if (!away.length) { foot.replaceChildren(); return }
      const key = away.map((p) => p.slug).join(',')
      if (foot.dataset.key !== key) {
        foot.dataset.key = key
        foot.innerHTML = `<h3 class="galley-picker-bucket">Not in this editor</h3>${away.map((p) => {
          const way = entry(p)
          const attrs = way ? `href="${esc(way.href)}"${way.external ? ' target="_blank" rel="noopener"' : ''}` : ''
          return `<a class="pp-away" data-slug="${esc(p.slug)}" ${attrs}><span class="pp-away-title">${esc(p.title)}</span><span class="galley-slot" data-slot="document"></span></a>`
        }).join('')}`
      }
      for (const p of away) fill(foot.querySelector<HTMLElement>(`.pp-away[data-slug="${CSS.escape(p.slug)}"] .galley-slot`)!, p, now)
    }

    async function poll(): Promise<void> {
      try {
        papers = await fetchPapers()
        fetchedAt = Date.now()
        draw()
      } catch (error) {
        console.warn('[galley] the papers could not be read:', error)
      } finally {
        if (!done) timer = window.setTimeout(() => { void poll() }, POLL_MS)
      }
    }

    clock = window.setInterval(() => draw(), 1000)
    void poll()
    return () => {
      done = true
      window.clearTimeout(timer)
      window.clearInterval(clock)
    }
  }
}
