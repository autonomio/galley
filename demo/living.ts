// The host's side of a paper written in the editor. While a paper's document
// is open, it keeps these current from the paper's live view and the store:
// - a strip under the toolbar: everyone at work on the paper, and what each is
//   doing right now;
// - working notes above the text: what the seed says, where the idea sits, the
//   direction, the evidence, the claims and the review, as each settles;
// - a mark in the margin beside the passage each agent is working on;
// - the text and its threads, merged with whatever the writer is doing.
// The History pane beside the editor, opened from the strip, lists what has
// happened and marks what is new since you last looked.
import type { DocumentStore, EditorPlugin } from '../src/index.js'

interface Member { seat: string, name: string, family: string | null, detail: string | null }
interface Working { seat: string, name: string, family: string | null, model: string, doing: string, section: string | null, finding: string | null, seconds: number }
interface Entry { at: string, seat: string, name: string, family: string | null, text: string, stage: string, section?: string, finding?: string, human?: boolean }
interface Note { key: string, label: string, text: string, seat: string, family: string | null }
interface Live {
  slug: string
  doc: string
  title: string
  running: boolean
  outcome: string | null
  stage: { id: string, label: string }
  team: Member[]
  sections: { id: string, title: string, written: boolean }[]
  now: Working[]
  waiting: { name: string, until: string } | null
  notes: Note[]
  activity: Entry[]
}

const POLL_MS = 2500
const STAGES: Record<string, string> = { seed: 'Seed', aim: 'Aim', substance: 'Materials', plan: 'Plan', evidence: 'Evidence', draft: 'Draft', review: 'Review', finish: 'Finish' }
const INITIALS: Record<string, string> = { author: 'A', checker: 'C', challenger: 'Ch', verifier: 'V', adjudicator: 'Ad', referee: 'R', methods: 'M', field: 'F', citations: 'Ci', editor: 'E', galley: 'G', human: 'Y' }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const minutes = (seconds: number) => (seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`)
const read = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* a convenience only */ } }

function face(seat: string, family: string | null, title: string, busy = false): string {
  return `<span class="lv-face${busy ? ' is-busy' : ''}" data-family="${esc(family ?? '')}" title="${esc(title)}">${esc(INITIALS[seat] ?? seat.charAt(0).toUpperCase())}</span>`
}

// A finding's thread in the editor: an agent's is `galley-<id>`; a person's own note is the note itself.
const threadId = (finding: string) => (finding.startsWith('H-ann-') ? finding.slice(2) : `galley-${finding}`)

export function livingPaper(store: DocumentStore, history: HTMLElement): EditorPlugin {
  return (editor) => {
    const header = editor.slot('header')
    const top = editor.slot('top')
    const marks = editor.layer('presence')
    let slug: string | null = null
    let live: Live | null = null
    let timer = 0
    let polling = false
    let open = read('galley-history-open') === '1'
    const signatures = { header: '', notes: '', history: '' }

    const seenKey = () => `galley-seen:${slug}`
    const seen = () => Number(read(seenKey()) || 0)
    const familyOf = (seat: string) => live?.team.find((m) => m.seat === seat)?.family ?? null

    function stop(): void {
      window.clearTimeout(timer)
      timer = 0
      live = null
      header.replaceChildren()
      top.replaceChildren()
      marks.replaceChildren()
      history.hidden = true
      document.body.classList.remove('has-history')
      signatures.header = signatures.notes = signatures.history = ''
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
        const [doc, notes] = await Promise.all([store.read(at), store.readAnnotations(at)])
        if (at !== slug) return
        editor.receive(at, doc.content, doc.version)
        editor.annotations.receive(notes.annotations, notes.version)
      } catch (error) {
        console.warn('[galley] the paper could not be read:', error)
      } finally {
        polling = false
        if (at === slug && live) timer = window.setTimeout(() => { void poll() }, POLL_MS)
      }
    }

    function draw(): void {
      if (!live) return
      drawHeader(live)
      drawNotes(live)
      drawMarks()
      drawHistory(live)
    }

    function drawHeader(l: Live): void {
      const working = new Map(l.now.map((n) => [n.seat, n]))
      const fresh = l.activity.filter((e) => !e.human && Date.parse(e.at) > seen()).length
      const people = [...l.team, ...l.now.filter((n) => !l.team.some((m) => m.seat === n.seat)).map((n) => ({ seat: n.seat, name: n.name, family: n.family, detail: n.model }))]
        .map((m) => {
          const n = working.get(m.seat)
          const title = `${m.name}${m.detail ? ` · ${m.detail}` : ''}${n ? ` · ${n.doing}, ${minutes(n.seconds)}` : ' · not working right now'}`
          return `<button type="button" class="lv-seat${n ? ' is-busy' : ''}" data-go="${esc(n?.finding ? `f:${n.finding}` : n?.section ? `s:${n.section}` : '')}" title="${esc(title)}">${face(m.seat, n?.family ?? m.family, title, !!n)}<span class="lv-seat-name">${esc(m.name)}</span>${n ? `<span class="lv-seat-doing">${esc(n.doing)}</span>` : ''}</button>`
        }).join('')
      const state = l.outcome === 'ready_for_submission' ? 'Ready for submission'
        : !l.running ? 'Paused'
        : l.waiting ? `Waiting for ${l.waiting.name} until ${clock(l.waiting.until)}`
        : `Writing · ${l.stage.label}`
      // The people scroll; where the paper stands and the History button stay in reach.
      const html = `<div class="lv-team" role="group" aria-label="Who is working on the paper">
        <div class="lv-people"><span class="lv-label">In the paper</span>${people}<span class="lv-seat lv-you">${face('human', null, 'You')}<span class="lv-seat-name">You</span></span></div>
        <div class="lv-end">
          <span class="lv-state${l.running ? ' is-running' : ''}">${esc(state)}</span>
          <button type="button" class="lv-history-btn" aria-pressed="${open}" data-history>History${fresh ? ` <span class="lv-new">${fresh}</span>` : ''}</button>
        </div>
      </div>`
      if (html === signatures.header) return
      signatures.header = html
      header.innerHTML = html
    }

    function drawNotes(l: Live): void {
      const folded = read('galley-notes-folded') === '1'
      const rows = l.notes.map((n) => `<div class="lv-note" data-key="${esc(n.key)}"><span class="lv-note-label">${esc(n.label)}</span><span class="lv-note-text">${esc(n.text)}</span>${face(n.seat, n.family ?? familyOf(n.seat), n.label)}</div>`)
      const html = `<section class="lv-notes" aria-label="Working notes"><header><span>Working notes</span><button type="button" class="lv-link" data-fold>${folded ? `Show all ${rows.length}` : 'Fold'}</button></header>${folded ? rows.slice(-1).join('') : rows.join('')}</section>`
      if (html === signatures.notes) return
      signatures.notes = html
      top.innerHTML = html
    }

    // An agent's mark sits in the margin of the passage it works on: the thread it answers, or its section's heading.
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
      if (!live) return
      const page = editor.page.getBoundingClientRect()
      const byLine = new Map<HTMLElement, Working[]>()
      for (const n of live.now) {
        const line = lineFor(n.finding, n.section)
        if (!line) continue
        byLine.set(line, [...(byLine.get(line) ?? []), n])
      }
      marks.replaceChildren(...[...byLine].map(([line, working]) => {
        const div = document.createElement('div')
        div.className = 'lv-mark'
        div.style.top = `${line.getBoundingClientRect().top - page.top}px`
        div.innerHTML = working.map((n) => face(n.seat, n.family, `${n.name} · ${n.doing}, ${minutes(n.seconds)}`, true)).join('')
        return div
      }))
    }

    function drawHistory(l: Live): void {
      history.hidden = !open
      document.body.classList.toggle('has-history', open)
      if (!open) return
      const since = seen()
      const now = l.now.length
        ? l.now.map((n) => `<li>${face(n.seat, n.family, n.name, true)}<span><b>${esc(n.name)}</b> ${esc(n.doing)} · ${minutes(n.seconds)}</span></li>`).join('')
        : `<li class="lv-quiet">${l.outcome === 'ready_for_submission' ? 'Ready for submission.' : l.running ? 'Between steps.' : 'Not running.'}</li>`
      let stage = ''
      let marked = false
      const rows: string[] = []
      for (const e of l.activity) {
        if (e.stage !== stage) { stage = e.stage; rows.push(`<li class="lv-stage">${esc(STAGES[stage] ?? stage)}</li>`) }
        const fresh = !e.human && Date.parse(e.at) > since
        if (fresh && !marked && since) { marked = true; rows.push('<li class="lv-divider">New since you last looked</li>') }
        const go = e.finding ? `f:${e.finding}` : e.section ? `s:${e.section}` : ''
        rows.push(`<li><button type="button" class="lv-entry${fresh ? ' is-new' : ''}${e.human ? ' is-you' : ''}" data-go="${esc(go)}"><time>${clock(e.at)}</time>${face(e.seat, e.family ?? familyOf(e.seat), e.name)}<span><b>${esc(e.name)}</b> ${esc(e.text)}</span></button></li>`)
      }
      const html = `<header class="lv-h"><b>Now</b><span class="lv-spacer"></span><button type="button" class="lv-link" data-read>Mark all read</button><button type="button" class="lv-link" data-history>Close</button></header>
        <ul class="lv-now">${now}</ul>
        <ol class="lv-log">${rows.join('')}</ol>`
      if (html === signatures.history) return
      const log = history.querySelector('.lv-log')
      const atBottom = !log || log.scrollTop + log.clientHeight > log.scrollHeight - 40
      signatures.history = html
      history.innerHTML = html
      const next = history.querySelector('.lv-log')
      if (next && atBottom) next.scrollTop = next.scrollHeight
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
      const line = lineFor(null, kind === 's' ? id : live?.sections[0]?.id ?? null)
      line?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }

    function onClick(event: MouseEvent): void {
      const target = event.target as HTMLElement
      if (target.closest('[data-history]')) {
        open = !open
        write('galley-history-open', open ? '1' : '0')
        // Closing the pane is having looked.
        if (!open && slug) write(seenKey(), String(Date.now()))
        signatures.header = signatures.history = ''
        draw()
        return
      }
      if (target.closest('[data-read]') && slug) { write(seenKey(), String(Date.now())); signatures.header = signatures.history = ''; draw(); return }
      if (target.closest('[data-fold]')) { write('galley-notes-folded', read('galley-notes-folded') === '1' ? '0' : '1'); signatures.notes = ''; draw(); return }
      const jump = target.closest<HTMLElement>('[data-go]')
      if (jump) go(jump.dataset.go ?? '')
    }

    header.addEventListener('click', onClick)
    top.addEventListener('click', onClick)
    history.addEventListener('click', onClick)
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
      header.removeEventListener('click', onClick)
      top.removeEventListener('click', onClick)
      history.removeEventListener('click', onClick)
    }
  }
}
