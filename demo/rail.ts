// Every paper beside the page, always: a rail before the text lists them all
// whichever document is open, so a glance tells whether each is being written,
// its stage, how long since it changed, who is at work on what, and how far
// its sections and review have come. The open paper is marked, and any other
// is one click away. It folds to a column of rings when the text wants the
// room; a narrow screen folds it by itself.
//
// Like the working notes, it is drawn once and then changed in place, so a
// poll that brings nothing new changes nothing on screen.
import { iconButton, type EditorPlugin } from '../src/index.js'
import { ago, elapsed, entry, fetchPapers, progressWords, quiet, stateOf, working, type Glance } from './glance.js'
import { esc, faceHTML, keyed, setText } from './living.js'

const POLL_MS = 3000
const FOLDED = 'galley-papers-folded'
// A panel with its divider: the rail folds and unfolds.
const PANEL = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5"/><path d="M6.25 2.75v10.5"/></svg>'

const read = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* a convenience only */ } }
const initials = (title: string) => title.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('')

/** Seats doing the same thing read as one: "Methods and Citations referees reviewing the whole manuscript". */
function together(names: string[]): string {
  if (names.length === 1) return names[0]
  const referees = names.every((n) => n.endsWith(' referee'))
  const bare = referees ? names.map((n) => n.replace(/ referee$/, '')) : names
  const list = `${bare.slice(0, -1).join(', ')} and ${bare.at(-1)}`
  return referees ? `${list} referees` : list
}

function where(p: Glance): string {
  const state = stateOf(p)
  if (state === 'ready') return p.mode === 'thesis' ? 'Brief ready' : 'Ready for submission'
  const round = p.progress.review ? ` · Round ${p.progress.review.round} of ${p.progress.review.rounds}` : ''
  return `${state === 'stopped' ? 'Stopped · ' : state === 'waiting' ? 'Waiting · ' : ''}${p.stage.label}${round}`
}

function howFar(p: Glance): string {
  const { sections, review } = p.progress
  return [sections ? `${sections.written}/${sections.total} sections` : null, review ? progressWords(p).findings : null].filter(Boolean).join(' · ')
}

interface Group { key: string, seats: ReturnType<typeof working>, doing: string }

export function papersRail(): EditorPlugin {
  return (editor) => {
    const slot = editor.slot('start')
    const rail = document.createElement('nav')
    rail.className = 'pr'
    rail.setAttribute('aria-label', 'Papers')
    rail.innerHTML = '<header class="pr-head"><span class="pr-title">Papers</span><span class="pr-count"></span></header><ol class="pr-list"></ol>'
    const head = rail.querySelector<HTMLElement>('.pr-head')!
    const count = rail.querySelector<HTMLElement>('.pr-count')!
    const list = rail.querySelector<HTMLElement>('.pr-list')!
    const fold = iconButton({ label: 'Fold the papers', description: 'Fold the rail to a ring a paper, to give the text the room.', icon: PANEL, className: 'pr-fold', onClick: () => setFolded(!rail.classList.contains('is-folded')) })
    head.append(fold)

    let papers: Glance[] = []
    let fetchedAt = Date.now()
    let drawn = false
    let timer = 0
    let done = false

    function setFolded(folded: boolean): void {
      rail.classList.toggle('is-folded', folded)
      write(FOLDED, folded ? '1' : '0')
      fold.setAttribute('aria-label', folded ? 'Show the papers' : 'Fold the papers')
      fold.dataset.description = folded ? 'Unfold the rail: every paper, where it stands and who is at work on what.' : 'Fold the rail to a ring a paper, to give the text the room.'
    }
    setFolded(read(FOLDED) === '1')

    function make(): HTMLElement {
      const li = document.createElement('li')
      li.className = 'pr-item'
      li.innerHTML = `<a class="pr-entry"><span class="pr-ring" aria-hidden="true"></span><span class="pr-body">
        <span class="pr-name"><i class="pr-dot" aria-hidden="true"></i><span class="pr-name-text"></span></span>
        <span class="pr-track" aria-hidden="true">${'<i></i>'.repeat(7)}</span>
        <span class="pr-meta"><span class="pr-where"></span><time class="pr-ago"></time></span>
        <span class="pr-far"></span>
        <span class="pr-now"></span>
        <span class="pr-quiet"></span>
      </span></a>`
      return li
    }

    function update(li: HTMLElement, p: Glance): void {
      const state = stateOf(p)
      li.dataset.state = state
      li.classList.toggle('is-current', p.document && p.doc === editor.slug)
      const a = li.querySelector<HTMLAnchorElement>('.pr-entry')!
      const way = entry(p)
      if (way && a.getAttribute('href') !== way.href) a.href = way.href
      if (way?.external) { a.target = '_blank'; a.rel = 'noopener' } else { a.removeAttribute('target'); a.removeAttribute('rel') }
      if (p.document) a.dataset.doc = p.doc
      else delete a.dataset.doc
      const title = `${p.title}\n${where(p)}${howFar(p) ? ` · ${howFar(p)}` : ''}`
      if (a.title !== title) a.title = title
      setText(li.querySelector('.pr-ring')!, initials(p.title))
      setText(li.querySelector('.pr-name-text')!, p.title)
      const current = p.stages.find((s) => !s.done)?.id
      li.querySelectorAll<HTMLElement>('.pr-track i').forEach((step, i) => {
        const s = p.stages[i]
        const value = !s ? 'todo' : s.done ? 'done' : s.id === current ? 'now' : 'todo'
        if (step.dataset.step !== value) step.dataset.step = value
      })
      setText(li.querySelector('.pr-where')!, where(p))
      setText(li.querySelector('.pr-far')!, howFar(p))
      // Who is at work: seats doing the same thing on one line, their faces together.
      const groups = new Map<string, Group>()
      if (state === 'running') for (const w of working(p)) {
        const g = groups.get(w.doing) ?? { key: '', seats: [], doing: w.doing }
        g.seats.push(w)
        g.key = `${g.seats.map((x) => x.seat).join('+')}|${w.doing}`
        groups.set(w.doing, g)
      }
      keyed(li.querySelector<HTMLElement>('.pr-now')!, [...groups.values()], (g) => g.key, (g) => {
        const row = document.createElement('span')
        row.className = 'pr-work'
        row.innerHTML = `<span class="pr-faces">${g.seats.map((w) => faceHTML(w.seat, w.family)).join('')}</span><span class="pr-doing"><b>${esc(together(g.seats.map((w) => w.name)))}</b> ${esc(g.doing)}</span><time></time>`
        return row
      }, (row, g) => {
        row.dataset.seconds = String(Math.max(...g.seats.map((w) => w.seconds)))
        const many = g.seats.reduce((n, w) => n + w.count, 0)
        row.dataset.more = many > g.seats.length ? String(many) : ''
      }, drawn ? 'height' : 'none')
      setText(li.querySelector('.pr-quiet')!, groups.size ? '' : quiet(p))
      tick(li, p)
    }

    function tick(li: HTMLElement, p: Glance, now = Date.now()): void {
      const since = Math.round((now - fetchedAt) / 1000)
      setText(li.querySelector('.pr-ago')!, ago(p.updated, now).replace(/ ago$/, ''))
      for (const row of li.querySelectorAll<HTMLElement>('.pr-work')) {
        setText(row.querySelector('time')!, `${elapsed(Number(row.dataset.seconds) + since)}${row.dataset.more ? ` ×${row.dataset.more}` : ''}`)
      }
    }

    function draw(): void {
      if (!papers.length) { rail.remove(); return }
      if (!rail.isConnected) slot.append(rail)
      const writing = papers.filter((p) => ['running', 'waiting'].includes(stateOf(p))).length
      const ready = papers.filter((p) => stateOf(p) === 'ready').length
      setText(count, [writing && `${writing} writing`, ready && `${ready} ready`].filter(Boolean).join(' · '))
      keyed(list, papers, (p) => p.slug, make, update, drawn ? 'height' : 'none')
      drawn = true
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

    // A paper whose document is here opens in place, a step Back returns from; anything else is an ordinary link.
    const onClick = (event: MouseEvent) => {
      const a = (event.target as HTMLElement).closest<HTMLAnchorElement>('a.pr-entry')
      if (!a?.dataset.doc || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      if (a.dataset.doc !== editor.slug) void editor.open(a.dataset.doc)
    }
    list.addEventListener('click', onClick)
    const offOpen = editor.on('open', () => { if (papers.length) draw() })
    const clock = window.setInterval(() => {
      const now = Date.now()
      for (const li of list.querySelectorAll<HTMLElement>('.pr-item')) {
        const p = papers.find((x) => x.slug === li.dataset.key)
        if (p) tick(li, p, now)
      }
    }, 1000)
    void poll()
    return () => {
      done = true
      window.clearTimeout(timer)
      window.clearInterval(clock)
      offOpen()
      list.removeEventListener('click', onClick)
      rail.remove()
    }
  }
}
