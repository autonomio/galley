// Every paper on a page of its own, at /papers/ (a paper's own files are at
// /papers/<doc>/). For each: whether it is being written, its stage, how long
// since anything in it changed, who is at work on what, how far its sections
// and review have come, and the way into it. Read from the papers' own files
// every few seconds; a poll that brings nothing new changes nothing on screen.
import '../src/styles/tokens.css'
import '../src/styles/galley.css'
import './demo.css'
import './living.css'
import './overview.css'
import { iconButton, icons } from '../src/index.js'
import { ago, elapsed, entry, fetchPapers, progressWords, quiet, stateOf, working, type Glance } from './glance.js'
import { faceHTML, keyed, setFace, setText } from './living.js'

const POLL_MS = 3000
const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.dataset.theme = theme

const root = document.getElementById('papers')!
root.className = 'galley ov'
root.dataset.galleyTheme = theme
root.innerHTML = `
  <header class="galley-bar ov-bar">
    <a class="demo-name ov-home" href="/${theme === 'light' ? '?theme=light' : ''}" title="Back to the editor">Galley</a>
    <span class="ov-crumb">Papers</span>
    <span class="ov-bar-end"></span>
  </header>
  <main class="ov-main">
    <div class="ov-inner">
      <header class="ov-head"><h1>Papers</h1><p class="ov-summary" aria-live="polite"></p></header>
      <ol class="ov-list"></ol>
      <p class="ov-empty" hidden>No papers yet. Open a document in the editor and write a paper from it.</p>
    </div>
  </main>`
const list = root.querySelector<HTMLElement>('.ov-list')!
const summary = root.querySelector<HTMLElement>('.ov-summary')!
const empty = root.querySelector<HTMLElement>('.ov-empty')!
root.querySelector('.ov-bar-end')!.append(iconButton({
  label: theme === 'light' ? 'Dark theme' : 'Light theme',
  description: `Show the page in ${theme === 'light' ? 'dark' : 'light'} colours.`,
  icon: theme === 'light' ? icons.moon : icons.sun,
  onClick: () => {
    const next = new URLSearchParams(location.search)
    if (theme === 'light') next.delete('theme')
    else next.set('theme', 'light')
    location.search = next.toString()
  },
}))

let papers: Glance[] = []
let fetchedAt = Date.now()
let drawn = false

function make(p: Glance): HTMLElement {
  const card = document.createElement('li')
  card.className = 'ov-card'
  card.innerHTML = `
    <div class="ov-top"><span class="ov-state"><i class="ov-dot" aria-hidden="true"></i><span class="ov-state-text"></span></span><time class="ov-ago"></time></div>
    <h2 class="ov-title"><a class="ov-hit"></a></h2>
    <ol class="ov-stages" aria-label="Stages">${p.stages.map((s) => `<li data-id="${s.id}">${s.label}</li>`).join('')}</ol>
    <ul class="ov-now" aria-label="At work now"></ul>
    <p class="ov-quiet"></p>
    <dl class="ov-stats">
      <div data-stat="sections"><dt>Sections</dt><dd><b></b><span></span></dd></div>
      <div data-stat="round"><dt>Review round</dt><dd><b></b><span></span></dd></div>
      <div data-stat="open"><dt>Findings open</dt><dd><b></b><span></span></dd></div>
    </dl>
    <footer class="ov-foot"><span class="ov-started"></span><nav class="ov-links"></nav></footer>`
  return card
}

function stat(card: HTMLElement, name: string, big: string | null, small: string, title: string | null): void {
  const box = card.querySelector<HTMLElement>(`[data-stat="${name}"]`)!
  box.classList.toggle('is-none', big === null)
  setText(box.querySelector('b')!, big ?? '—')
  setText(box.querySelector('span')!, big === null ? '' : small)
  box.title = title ?? ''
}

function link(href: string, text: string, external: boolean): HTMLAnchorElement {
  const a = document.createElement('a')
  a.href = href
  a.textContent = text
  if (external) { a.target = '_blank'; a.rel = 'noopener' }
  return a
}

function update(card: HTMLElement, p: Glance): void {
  const state = stateOf(p)
  card.dataset.state = state
  setText(card.querySelector('.ov-state-text')!, state === 'running' ? `Writing · ${p.stage.label}` : state === 'waiting' ? `Waiting · ${p.stage.label}` : state === 'ready' ? 'Ready for submission' : `Stopped · ${p.stage.label}`)
  const hit = card.querySelector<HTMLAnchorElement>('.ov-hit')!
  setText(hit, p.title)
  const way = entry(p)
  if (way) {
    if (hit.getAttribute('href') !== way.href) hit.href = way.href
    if (way.external) { hit.target = '_blank'; hit.rel = 'noopener' } else { hit.removeAttribute('target'); hit.removeAttribute('rel') }
  } else hit.removeAttribute('href')
  const current = p.stages.find((s) => !s.done)?.id
  for (const li of card.querySelectorAll<HTMLElement>('.ov-stages li')) {
    const s = p.stages.find((x) => x.id === li.dataset.id)
    const step = s?.done ? 'done' : s?.id === current ? 'now' : 'todo'
    if (li.dataset.step !== step) li.dataset.step = step
  }
  keyed(card.querySelector<HTMLElement>('.ov-now')!, state === 'running' ? working(p) : [], (w) => w.seat, (w) => {
    const row = document.createElement('li')
    row.className = 'ov-now-row'
    row.innerHTML = `${faceHTML(w.seat, w.family)}<p><b></b> <span></span></p><time></time>`
    return row
  }, (row, w) => {
    setFace(row, w.seat, w.family, true)
    setText(row.querySelector('b')!, w.name)
    setText(row.querySelector('p > span')!, w.doing)
    row.dataset.seconds = String(w.seconds)
    row.dataset.count = String(w.count)
  }, drawn ? 'height' : 'none')
  setText(card.querySelector('.ov-quiet')!, state === 'running' && p.now.length ? '' : quiet(p))
  const words = progressWords(p)
  const { sections, review } = p.progress
  stat(card, 'sections', sections ? String(sections.written) : null, sections ? `/${sections.total}` : '', words.sections)
  stat(card, 'round', review ? String(review.round) : null, review ? ` of ${review.rounds}` : '', words.round)
  stat(card, 'open', review ? String(review.open) : null, review ? ` of ${review.findings}` : '', words.findings)
  const links = card.querySelector<HTMLElement>('.ov-links')!
  const wanted = [
    ...(way ? [[way.href, way.external ? 'Open the PDF' : 'Open the paper', way.external] as const] : []),
    ...(p.document && p.pdf ? [[`/papers/${encodeURIComponent(p.doc)}/paper.pdf`, 'PDF', true] as const, [`/papers/${encodeURIComponent(p.doc)}/`, 'Files', false] as const] : []),
  ]
  const key = JSON.stringify(wanted)
  if (links.dataset.key !== key) {
    links.dataset.key = key
    links.replaceChildren(...wanted.map(([href, text, external]) => link(href, text, external)))
  }
  tick(card, p)
}

// What changes with the clock alone: how long ago, and for how long each has been at it.
function tick(card: HTMLElement, p: Glance, now = Date.now()): void {
  const since = Math.round((now - fetchedAt) / 1000)
  const changed = card.querySelector<HTMLTimeElement>('.ov-ago')!
  setText(changed, `changed ${ago(p.updated, now)}`)
  if (p.updated) changed.dateTime = p.updated
  setText(card.querySelector('.ov-started')!, p.started ? `Started ${ago(p.started, now)}` : '')
  for (const row of card.querySelectorAll<HTMLElement>('.ov-now-row')) {
    const count = Number(row.dataset.count)
    setText(row.querySelector('time')!, `${elapsed(Number(row.dataset.seconds) + since)}${count > 1 ? ` · ${count} at once` : ''}`)
  }
}

function draw(): void {
  const counts = { writing: 0, ready: 0, stopped: 0 }
  for (const p of papers) {
    const s = stateOf(p)
    counts[s === 'ready' ? 'ready' : s === 'stopped' ? 'stopped' : 'writing']++
  }
  setText(summary, [counts.writing && `${counts.writing} being written`, counts.ready && `${counts.ready} ready for submission`, counts.stopped && `${counts.stopped} stopped`].filter(Boolean).join(' · '))
  empty.hidden = papers.length > 0
  keyed(list, papers, (p) => p.slug, make, update, drawn ? 'height' : 'none')
  drawn = true
}

async function poll(): Promise<void> {
  try {
    papers = await fetchPapers()
    fetchedAt = Date.now()
    draw()
  } catch (error) {
    setText(summary, 'The papers could not be read just now; trying again.')
    console.warn('[galley]', error)
  } finally {
    window.setTimeout(() => { void poll() }, POLL_MS)
  }
}

window.setInterval(() => {
  const now = Date.now()
  for (const card of list.querySelectorAll<HTMLElement>('.ov-card')) {
    const p = papers.find((x) => x.slug === card.dataset.key)
    if (p) tick(card, p, now)
  }
}, 1000)
void poll()
