// The host's side of a paper written in the editor. While a paper's document
// is open it keeps these current, from the paper's live view and the store:
// - at the end of the editor's row: a face for everyone on the paper, in
//   colour and breathing while they work; where the paper stands; and the
//   Activity button, with what is new since you last looked;
// - working notes above the text: what the seed says, where the idea sits,
//   the direction, the evidence, the claims and the review, as each settles;
// - a face in the margin beside the passage each agent is working on;
// - the text and its threads, merged with whatever the writer is doing.
// The Activity pane beside the page puts who is doing what right now first,
// apart from everything that has happened, which follows newest first.
//
// Everything is drawn once and then changed in place, item by item: a poll
// that brings nothing new changes nothing on screen, and what is new arrives
// with a little motion. Redrawing it all on every poll restarted every
// animation and made the strip and the history flash every few seconds.
import { icons, iconButton, type DocumentStore, type EditorPlugin } from '../src/index.js'
import type { Router } from './route.js'

interface Member { seat: string, name: string, family: string | null, detail: string | null }
interface Working { seat: string, name: string, family: string | null, model: string, doing: string, section: string | null, finding: string | null, seconds: number }
interface Entry { at: string, seat: string, name: string, family: string | null, text: string, stage: string, section?: string, finding?: string, human?: boolean }
interface Note { key: string, label: string, text: string, seat: string, family: string | null }
interface Live {
  slug: string
  doc: string
  title: string
  mode: 'paper' | 'thesis'
  running: boolean
  outcome: string | null
  ready: boolean
  stage: { id: string, label: string }
  team: Member[]
  sections: { id: string, title: string, written: boolean }[]
  now: Working[]
  waiting: { name: string, until: string } | null
  notes: Note[]
  activity: Entry[]
}
type State = 'running' | 'waiting' | 'paused' | 'ready'
export type Arrival = 'height' | 'fade' | 'none'

const POLL_MS = 2500
const STAGES: Record<string, string> = { seed: 'Seed', aim: 'Aim', substance: 'Materials', plan: 'Plan', evidence: 'Evidence', draft: 'Draft', review: 'Review', finish: 'Finish', thesis: 'Thesis', test: 'Test', brief: 'Brief' }
const INITIALS: Record<string, string> = { author: 'A', checker: 'C', challenger: 'Ch', verifier: 'V', adjudicator: 'Ad', referee: 'R', methods: 'M', field: 'F', citations: 'Ci', editor: 'E', galley: 'G', human: 'Y' }
// How far apart faces stack in the margin when several work on one passage.
const STACK_PX = 26

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const elapsed = (seconds: number) => (seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`)
const read = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* a convenience only */ } }
const quietMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/**
 * Set text only when it changed, so an unchanged poll touches nothing; and change it in place, so a line that ticks
 * (how long ago the paper last changed) keeps its node and redraws nothing around it.
 */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent === text) return
  const only = node.childNodes.length === 1 && node.firstChild!.nodeType === Node.TEXT_NODE ? node.firstChild as Text : null
  if (only) only.data = text
  else node.textContent = text
}

export function faceHTML(seat: string, family: string | null): string {
  return `<span class="lv-face" data-family="${esc(family ?? '')}">${esc(INITIALS[seat] ?? seat.charAt(0).toUpperCase())}</span>`
}

/** Bring the face inside `host` up to date without replacing it, so its breathing never restarts. */
export function setFace(host: HTMLElement, seat: string, family: string | null, busy: boolean): void {
  let face = host.querySelector<HTMLElement>('.lv-face')
  if (!face) { host.insertAdjacentHTML('afterbegin', faceHTML(seat, family)); face = host.querySelector<HTMLElement>('.lv-face')! }
  if (face.dataset.family !== (family ?? '')) face.dataset.family = family ?? ''
  setText(face, INITIALS[seat] ?? seat.charAt(0).toUpperCase())
  face.classList.toggle('is-busy', busy)
}

function arrive(nodes: HTMLElement[], how: Arrival): void {
  if (how === 'none' || !nodes.length || quietMotion()) return
  // Measure them all, then start them all: one layout.
  const heights = how === 'height' ? nodes.map((node) => node.offsetHeight) : []
  nodes.forEach((node, i) => {
    if (how === 'height') node.style.setProperty('--lv-h', `${heights[i]}px`)
    const name = how === 'height' ? 'lv-in-height' : 'lv-in-fade'
    node.classList.add(name)
    const done = (event: AnimationEvent) => {
      if (event.target !== node) return
      node.removeEventListener('animationend', done)
      node.classList.remove(name)
      node.style.removeProperty('--lv-h')
    }
    node.addEventListener('animationend', done)
  })
}

function depart(node: HTMLElement, how: Arrival): void {
  if (how === 'none' || quietMotion()) { node.remove(); return }
  if (how === 'height') node.style.setProperty('--lv-h', `${node.offsetHeight}px`)
  node.classList.add('is-leaving', how === 'height' ? 'lv-out-height' : 'lv-out-fade')
  const done = () => node.remove()
  node.addEventListener('animationend', (event) => { if (event.target === node) done() })
  window.setTimeout(done, 1500)
}

/**
 * Keep `parent`'s children in step with `items`, by key: an element whose item
 * is still there is updated in place, a new item gets a new element, and the
 * element of an item that is gone leaves. `how` is how arrivals and departures move.
 */
export function keyed<T>(parent: HTMLElement, items: T[], key: (item: T) => string, make: (item: T) => HTMLElement, update: (node: HTMLElement, item: T) => void, how: Arrival): void {
  const existing = new Map<string, HTMLElement>()
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    if (child.dataset.key !== undefined && !child.classList.contains('is-leaving')) existing.set(child.dataset.key, child)
  }
  const made: HTMLElement[] = []
  const wanted = new Set<string>()
  let cursor = parent.firstElementChild as HTMLElement | null
  for (const item of items) {
    const k = key(item)
    wanted.add(k)
    let node = existing.get(k)
    if (!node) { node = make(item); node.dataset.key = k; made.push(node) }
    update(node, item)
    while (cursor && cursor !== node && cursor.classList.contains('is-leaving')) cursor = cursor.nextElementSibling as HTMLElement | null
    if (cursor === node) cursor = cursor.nextElementSibling as HTMLElement | null
    else parent.insertBefore(node, cursor)
  }
  for (const [k, node] of existing) if (!wanted.has(k)) depart(node, how)
  arrive(made, how)
}

/** Keys made unique: a seat can work on several sections at once, so the second of a key gets `#1`, and so on. */
function unique<T>(items: T[], base: (item: T) => string): { item: T, key: string }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const k = base(item)
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return { item, key: n ? `${k}#${n}` : k }
  })
}
// What one agent is doing, told apart from what it does elsewhere at the same time.
const workKey = (n: Working) => `${n.seat}|${n.section ?? ''}|${n.finding ?? ''}`

// A finding's thread in the editor: an agent's is `galley-<id>`; a person's own note is the note itself.
const threadId = (finding: string) => (finding.startsWith('H-ann-') ? finding.slice(2) : `galley-${finding}`)
const stateOf = (l: Live): State => (l.ready ? 'ready' : !l.running ? 'paused' : l.waiting ? 'waiting' : 'running')
const goTo = (n: Working | undefined) => (n?.finding ? `f:${n.finding}` : n?.section ? `s:${n.section}` : '')

/** `link` puts Activity in the address bar (view=activity), so a link can open it. */
export function livingPaper(store: DocumentStore, link?: Router): EditorPlugin {
  return (editor) => {
    const end = editor.slot('bar-end')
    const top = editor.slot('top')
    const side = editor.slot('side')
    const presence = editor.layer('presence')
    let slug: string | null = null
    let live: Live | null = null
    let timer = 0
    let polling = false
    // Whether Activity is open is the link's to say, so it opens for whoever opens the link.
    let open = false
    let paneDrawn = false
    let barDrawn = false

    const seenKey = () => `galley-seen:${slug}`
    const seen = () => Number(read(seenKey()) || 0)
    const markSeen = () => { if (slug) write(seenKey(), String(Date.now())) }
    const familyOf = (seat: string) => live?.team.find((m) => m.seat === seat)?.family ?? null
    const isNew = (e: Entry, since: number) => !e.human && Date.parse(e.at) > since

    // ── The row: faces, where the paper stands, Activity ─────────────
    const bar = el('div', 'lv-bar')
    bar.hidden = true
    const faces = el('div', 'lv-faces')
    faces.setAttribute('role', 'group')
    faces.setAttribute('aria-label', 'On the paper')
    const stage = el('span', 'lv-stage')
    const activity = iconButton({
      label: 'Activity',
      description: 'Who is working on what right now, and everything that has happened to the paper.',
      icon: icons.activity,
      className: 'lv-activity-btn',
      onClick: () => setOpen(!open),
    })
    activity.setAttribute('aria-pressed', 'false')
    const badge = el('span', 'lv-badge')
    activity.append(badge)
    bar.append(faces, stage, activity)
    // First in the slot, so the host's own controls follow, whenever they were added.
    end.prepend(bar)

    // ── Working notes above the text ─────────────────────────────────
    const notes = el('section', 'lv-notes')
    notes.setAttribute('aria-label', 'Working notes')
    const notesHead = el('header', 'lv-notes-head')
    const notesTitle = el('span', 'lv-notes-title')
    notesTitle.textContent = 'Working notes'
    const fold = iconButton({
      label: 'Fold the notes',
      icon: icons.chevronUp,
      className: 'lv-fold',
      onClick: () => {
        write('galley-notes-folded', read('galley-notes-folded') === '1' ? '0' : '1')
        if (live) drawNotes(live)
      },
    })
    notesHead.append(notesTitle, fold)
    const noteRows = el('div', 'lv-note-rows')
    notes.append(notesHead, noteRows)

    // ── The Activity pane ────────────────────────────────────────────
    side.hidden = true
    const paneHead = el('header', 'lv-pane-head')
    const paneTitle = el('h2')
    paneTitle.textContent = 'Activity'
    const markRead = iconButton({ label: 'Mark all read', description: 'Clear what is marked new.', icon: icons.checks, onClick: () => { markSeen(); draw() } })
    const close = iconButton({ label: 'Close', description: 'Close Activity.', icon: icons.close, onClick: () => setOpen(false) })
    paneHead.append(paneTitle, markRead, close)
    const now = el('section', 'lv-now')
    now.setAttribute('aria-label', 'Now')
    const nowHead = el('header', 'lv-now-head')
    nowHead.innerHTML = '<span class="lv-live" aria-hidden="true"></span><span class="lv-now-title">Now</span>'
    const nowStage = el('span', 'lv-now-stage')
    nowHead.append(nowStage)
    const nowList = el('ul', 'lv-now-list')
    const quiet = el('p', 'lv-now-quiet')
    now.append(nowHead, nowList, quiet)
    const log = el('div', 'lv-log')
    log.setAttribute('aria-label', 'What has happened, newest first')
    side.append(paneHead, now, log)
    link?.view('activity', { set: (on) => setOpen(on) })

    function setOpen(next: boolean): void {
      if (next === open) return
      open = next
      link?.shown('activity', open)
      // Closing the pane is having looked.
      if (!open) { markSeen(); paneDrawn = false }
      if (open) {
        side.classList.remove('lv-opening')
        void side.offsetWidth
        side.classList.add('lv-opening')
      }
      draw()
    }

    function stop(): void {
      window.clearTimeout(timer)
      timer = 0
      live = null
      bar.hidden = true
      barDrawn = false
      faces.replaceChildren()
      notes.remove()
      noteRows.replaceChildren()
      presence.replaceChildren()
      side.hidden = true
      nowList.replaceChildren()
      log.replaceChildren()
      paneDrawn = false
    }

    async function poll(): Promise<void> {
      const at = slug
      if (!at || polling) return
      polling = true
      try {
        const res = await fetch(`/api/galley-live/${encodeURIComponent(at)}`, { cache: 'no-store' })
        if (at !== slug) return
        if (!res.ok) { stop(); return }
        live = await res.json() as Live
        draw()
        // The text and its threads as the paper has them now, merged with the writer's own work.
        const [doc, threads] = await Promise.all([store.read(at), store.readAnnotations(at)])
        if (at !== slug) return
        editor.receive(at, doc.content, doc.version)
        editor.annotations.receive(threads.annotations, threads.version)
      } catch (error) {
        console.warn('[galley] the paper could not be read:', error)
      } finally {
        polling = false
        if (at === slug && live) timer = window.setTimeout(() => { void poll() }, POLL_MS)
      }
    }

    function draw(): void {
      if (!live) return
      drawBar(live)
      drawNotes(live)
      drawMarks()
      drawPane(live)
    }

    function drawBar(l: Live): void {
      bar.hidden = false
      const working = new Map<string, Working>()
      const more = new Map<string, number>()
      for (const n of l.now) {
        if (working.has(n.seat)) more.set(n.seat, (more.get(n.seat) ?? 0) + 1)
        else working.set(n.seat, n)
      }
      const people: Member[] = [...l.team]
      for (const n of l.now) if (!people.some((m) => m.seat === n.seat)) people.push({ seat: n.seat, name: n.name, family: n.family, detail: n.model })
      keyed(faces, people, (m) => m.seat, (m) => iconButton({
        label: m.name,
        icon: '',
        className: 'lv-seat',
        onClick: (button) => (button.dataset.go ? go(button.dataset.go) : setOpen(true)),
      }), (button, m) => {
        const n = working.get(m.seat)
        setFace(button, m.seat, n?.family ?? m.family, !!n)
        button.classList.toggle('is-busy', !!n)
        button.dataset.go = goTo(n)
        const also = more.get(m.seat)
        const what = [m.detail, n ? `${n.doing}, ${elapsed(n.seconds)}${also ? `, and ${also} more at once` : ''}` : 'not working right now'].filter(Boolean).join(' · ')
        if (button.dataset.description !== what) button.dataset.description = what
      }, barDrawn ? 'fade' : 'none')
      barDrawn = true
      const state = stateOf(l)
      stage.dataset.state = state
      setText(stage, state === 'ready' ? (l.mode === 'thesis' ? 'Brief ready' : 'Ready for submission') : state === 'paused' ? 'Paused' : state === 'waiting' ? `Waiting until ${clock(l.waiting!.until)}` : l.stage.label)
      stage.title = state === 'running' ? `Writing · ${l.stage.label}` : stage.textContent ?? ''
      const fresh = l.activity.filter((e) => isNew(e, seen())).length
      setText(badge, fresh ? String(fresh) : '')
      const label = fresh ? `Activity, ${fresh} new` : 'Activity'
      if (activity.getAttribute('aria-label') !== label) activity.setAttribute('aria-label', label)
      activity.setAttribute('aria-pressed', String(open))
    }

    function drawNotes(l: Live): void {
      if (!l.notes.length) { notes.remove(); return }
      const first = !notes.isConnected
      if (first) top.append(notes)
      const folded = read('galley-notes-folded') === '1'
      notes.classList.toggle('is-folded', folded)
      keyed(noteRows, folded ? l.notes.slice(-1) : l.notes, (n) => n.key, () => {
        const row = el('div', 'lv-note')
        row.innerHTML = '<span class="lv-note-label"></span><span class="lv-note-text"></span>'
        return row
      }, (row, n) => {
        setText(row.querySelector<HTMLElement>('.lv-note-label')!, n.label)
        setText(row.querySelector<HTMLElement>('.lv-note-text')!, n.text)
        setFace(row, n.seat, n.family ?? familyOf(n.seat), false)
        const face = row.querySelector<HTMLElement>('.lv-face')!
        if (face !== row.lastElementChild) row.append(face)
        face.title = n.label
      }, first ? 'none' : 'height')
      const state = folded ? 'folded' : 'open'
      if (fold.dataset.state !== state) {
        fold.dataset.state = state
        fold.innerHTML = folded ? icons.chevronDown : icons.chevronUp
      }
      const label = folded ? `Show all ${l.notes.length} notes` : 'Fold the notes'
      if (fold.getAttribute('aria-label') !== label) fold.setAttribute('aria-label', label)
    }

    // An agent's face sits in the margin of the passage it works on: the thread it answers, or its section's heading.
    function lineFor(finding: string | null, section: string | null): HTMLElement | null {
      const lines = editor.surface.lines()
      if (finding) {
        const note = editor.annotations.list().find((a) => a.id === threadId(finding))
        if (note) return lines[Math.min(note.range.start_line, lines.length - 1)] ?? null
      }
      const title = section ? live?.sections.find((s) => s.id === section)?.title : null
      if (title) return lines.find((line) => (line.textContent ?? '').replace(/^#+\s*/, '') === title) ?? null
      return lines[0] ?? null
    }

    function drawMarks(): void {
      if (!live) { presence.replaceChildren(); return }
      const stacked = new Map<HTMLElement, number>()
      const items: { n: Working, y: number, key: string }[] = []
      for (const { item: n, key } of unique(live.now, workKey)) {
        const line = lineFor(n.finding, n.section)
        if (!line) continue
        const k = stacked.get(line) ?? 0
        stacked.set(line, k + 1)
        items.push({ n, y: line.offsetTop + k * STACK_PX, key })
      }
      keyed(presence, items, (i) => i.key, (i) => {
        const mark = el('div', 'lv-mark')
        mark.append(iconButton({ label: i.n.name, icon: '', className: 'lv-mark-face', onClick: (button) => go(button.dataset.go ?? '') }))
        return mark
      }, (mark, i) => {
        const button = mark.firstElementChild as HTMLElement
        setFace(button, i.n.seat, i.n.family, true)
        button.dataset.go = goTo(i.n)
        const what = `${i.n.doing}, ${elapsed(i.n.seconds)}`
        if (button.dataset.description !== what) button.dataset.description = what
        const y = `${i.y}px`
        if (mark.style.getPropertyValue('--lv-y') === y) return
        mark.style.setProperty('--lv-y', y)
        // A face placed for the first time appears there; after that it glides to its next passage.
        if (!mark.classList.contains('is-placed')) requestAnimationFrame(() => mark.classList.add('is-placed'))
      }, 'fade')
    }

    function drawPane(l: Live): void {
      side.hidden = !open
      activity.setAttribute('aria-pressed', String(open))
      if (!open) return
      const how: Arrival = paneDrawn ? 'height' : 'none'
      const state = stateOf(l)
      now.dataset.state = state
      setText(nowStage, l.stage.label)
      keyed(nowList, unique(l.now, workKey), (x) => x.key, ({ item: n }) => {
        const row = el('li', 'lv-now-row')
        row.innerHTML = `${faceHTML(n.seat, n.family)}<p><b></b> <span></span></p><time></time>`
        return row
      }, (row, { item: n }) => {
        setFace(row, n.seat, n.family, true)
        setText(row.querySelector('b')!, n.name)
        setText(row.querySelector('p > span')!, n.doing)
        setText(row.querySelector('time')!, elapsed(n.seconds))
      }, how)
      setText(quiet, state === 'ready' ? 'Ready for submission.' : state === 'paused' ? 'Not running.' : state === 'waiting' ? `Waiting for ${l.waiting!.name} until ${clock(l.waiting!.until)}.` : 'Between steps.')

      // Runs of one stage, numbered from the oldest so a run keeps its key as entries arrive; shown newest first.
      const runs: { key: string, stage: string, entries: Entry[] }[] = []
      for (const e of l.activity) {
        const last = runs[runs.length - 1]
        if (last && last.stage === e.stage) last.entries.push(e)
        else runs.push({ key: `${e.stage}:${runs.length}`, stage: e.stage, entries: [e] })
      }
      const since = seen()
      keyed(log, runs.reverse(), (run) => run.key, () => {
        const group = el('section', 'lv-group')
        group.append(el('h3', 'lv-group-label'), el('ol', 'lv-entries'))
        return group
      }, (group, run) => {
        setText(group.firstElementChild as HTMLElement, STAGES[run.stage] ?? run.stage)
        const entries = unique([...run.entries].reverse(), (e) => `${e.at}|${e.seat}|${e.text}`)
        keyed(group.lastElementChild as HTMLElement, entries, (x) => x.key, ({ item: e }) => {
          const row = el('li', 'lv-row')
          const family = e.human ? 'you' : e.family ?? familyOf(e.seat)
          row.innerHTML = `<button type="button" class="lv-entry${e.human ? ' is-you' : ''}"><time>${clock(e.at)}</time>${faceHTML(e.seat, family)}<span class="lv-entry-text"><b>${esc(e.name)}</b> ${esc(e.text)}</span></button>`
          return row
        }, (row, { item: e }) => {
          const entry = row.firstElementChild as HTMLElement
          entry.classList.toggle('is-new', isNew(e, since))
          const target = e.finding ? `f:${e.finding}` : e.section ? `s:${e.section}` : ''
          if (entry.dataset.go !== target) entry.dataset.go = target
        }, how)
      }, how)
      paneDrawn = true
    }

    function go(target: string): void {
      if (!target) return
      const [kind, id] = [target.slice(0, 1), target.slice(2)]
      if (kind === 'f') {
        const note = editor.annotations.list().find((a) => a.id === threadId(id))
        if (note) {
          editor.surface.lines()[note.range.start_line]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          editor.annotations.open(note.id)
          return
        }
      }
      lineFor(null, kind === 's' ? id : live?.sections[0]?.id ?? null)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }

    const onLog = (event: MouseEvent) => {
      const entry = (event.target as HTMLElement).closest<HTMLElement>('.lv-entry')
      if (entry?.dataset.go) go(entry.dataset.go)
    }
    log.addEventListener('click', onLog)
    const offOpen = editor.on('open', ({ slug: opened }) => {
      stop()
      slug = opened
      void poll()
    })
    const offLayout = editor.on('layout', () => drawMarks())
    return () => {
      offOpen()
      offLayout()
      stop()
      slug = null
      log.removeEventListener('click', onLog)
      bar.remove()
      side.replaceChildren()
    }
  }
}
