// The comments column: every note a card beside the text, level with the
// first line of its passage and pushed down past the card above it, so no two
// overlap. While a note is open its card sits level with its passage and the
// cards above it make way.
//
// The column is drawn in the page's own coordinates, just past its right
// edge, so the cards scroll with the text and line up with its marks. The room
// it takes is kept free on the main column's right (`galley--margin`), so the
// page and its column are centred together. Where that room would leave the
// text less than two thirds of its measure, the column steps aside, and the
// marks open the panel under the passage as they always have.
//
// A card is a summary: who wrote the note, its labels, the comment cut to a
// few lines and how many answers it has. Pressing one opens its thread in the
// panel. Pointing at a card lights its passage, and pointing at a passage
// lights its card. A settled thread's card is quieter; a note whose passage is
// gone stays where the passage was last seen.
import type { Annotation } from '../types.js'
import { el, escapeHtml } from './dom.js'
import type { NotePlace } from './marks.js'
import { faceHtml, inline, labelsHtml } from './notes.js'

// The text keeps at least this much of its measure, or the column steps aside.
const MIN_MEASURE = 2 / 3
// Between one card and the next.
const GAP = 8

export interface Margin {
  /**
   * Take the room beside the text for `count` notes, or give it back: true
   * while the column is shown. Ask before drawing the marks, since taking the
   * room narrows the text.
   */
  fit(count: number): boolean
  /** A card for every note at its place, and its passage lit while it is pointed at or open. */
  draw(annotations: Annotation[], places: Map<string, NotePlace>, open: string | null): void
}

/**
 * Where each card goes: level with its passage, below the card before it,
 * never above the page. The card at `anchor` stays level with its passage
 * and the cards before it move up to make way.
 */
export function stack(cards: { top: number, height: number }[], anchor = -1): number[] {
  const tops = cards.map((card) => card.top)
  for (let i = anchor - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - GAP - cards[i].height)
  for (let i = 0; i < tops.length; i++) tops[i] = Math.max(tops[i], i ? tops[i - 1] + cards[i - 1].height + GAP : 0)
  return tops
}

function cardHtml(a: Annotation, orphan: boolean, me: string): string {
  const replies = a.replies?.length ?? 0
  const comment = a.comment.trim().replace(/\s+/g, ' ')
  return `<span class="galley-card-who">${faceHtml(a.author ?? null, me)}<span class="galley-card-head"><b>${escapeHtml(a.author?.name ?? me)}</b>${labelsHtml(a.labels ?? [])}${orphan ? '<span class="galley-card-gone">Passage changed</span>' : ''}</span></span>`
    + (comment ? `<span class="galley-card-text">${inline(comment)}</span>` : '')
    + (replies ? `<span class="galley-card-replies">${replies === 1 ? '1 reply' : `${replies} replies`}</span>` : '')
}

export function createMargin(options: {
  root: HTMLElement
  /** The scrolling column the page sits in, whose room the cards share. */
  main: HTMLElement
  page: HTMLElement
  /** The layer the note marks are drawn in. */
  marks: HTMLElement
  /** The writer's name, for their own notes. */
  me: string
  open(id: string): void
}): Margin {
  const { root, main, page, marks, me } = options
  const column = el('aside', { class: 'galley-margin', 'aria-label': 'Comments', hidden: '' })
  page.append(column)
  const cards = new Map<string, { card: HTMLButtonElement, html: string }>()
  let shown = false
  let hovered: string | null = null
  let opened: string | null = null

  function fit(count: number): boolean {
    let room = false
    if (count > 0) {
      // Read from the stylesheet, so a host's tokens size the column and the measure it protects.
      const style = getComputedStyle(column)
      const pad = parseFloat(getComputedStyle(main).paddingLeft) || 0
      const need = parseFloat(style.width) + parseFloat(style.marginLeft)
      const measure = parseFloat(getComputedStyle(page).maxWidth) || 0
      room = main.clientWidth - 2 * pad - need >= measure * MIN_MEASURE
    }
    if (room !== shown) {
      shown = room
      root.classList.toggle('galley--margin', room)
      column.hidden = !room
      if (!room) {
        column.replaceChildren()
        cards.clear()
      }
    }
    return room
  }

  function layout(annotations: Annotation[], places: Map<string, NotePlace>): void {
    const placed = annotations
      .flatMap((a) => {
        const place = places.get(a.id)
        return place ? [{ a, place }] : []
      })
      .sort((x, y) => x.place.top - y.place.top || x.place.left - y.place.left)
    const wanted = new Set(placed.map(({ a }) => a.id))
    for (const [id, { card }] of cards) {
      if (wanted.has(id)) continue
      card.remove()
      cards.delete(id)
    }
    // In passage order, so the keyboard walks them as the text reads. A card
    // moves in the list only when it is out of order: moving one takes its focus.
    let cursor = column.firstElementChild
    const list = placed.map(({ a, place }) => {
      let entry = cards.get(a.id)
      if (!entry) {
        entry = { card: el('button', { type: 'button', class: 'galley-card', 'data-annotation': a.id }), html: '' }
        cards.set(a.id, entry)
      }
      const { card } = entry
      const html = cardHtml(a, place.orphan, me)
      if (entry.html !== html) {
        card.innerHTML = html
        entry.html = html
      }
      card.classList.toggle('is-resolved', !!a.resolved)
      card.classList.toggle('is-orphan', place.orphan)
      if (cursor === card) cursor = card.nextElementSibling
      else column.insertBefore(card, cursor)
      return card
    })
    // Measure them all, then place them all: one layout.
    const heights = list.map((card) => card.offsetHeight)
    const tops = stack(placed.map(({ place }, i) => ({ top: place.top, height: heights[i] })), placed.findIndex(({ a }) => a.id === opened))
    list.forEach((card, i) => {
      const top = `${tops[i]}px`
      if (card.style.top !== top) card.style.top = top
    })
  }

  function light(): void {
    for (const [id, { card }] of cards) {
      card.classList.toggle('is-hovered', id === hovered)
      card.classList.toggle('is-open', id === opened)
    }
    for (const mark of Array.from(marks.children) as HTMLElement[]) {
      mark.classList.toggle('is-hovered', mark.dataset.annotation === hovered)
      mark.classList.toggle('is-open', mark.dataset.annotation === opened)
    }
  }

  const noteAt = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('[data-annotation]')?.dataset.annotation ?? null : null)
  function hover(id: string | null): void {
    if (id === hovered) return
    hovered = id
    light()
  }
  for (const layer of [column, marks]) {
    layer.addEventListener('pointerover', (event) => hover(noteAt(event.target)))
    // From one rect of a passage to the next is still the same note.
    layer.addEventListener('pointerout', (event) => { if (noteAt(event.relatedTarget) !== hovered) hover(null) })
  }
  column.addEventListener('click', (event) => {
    const id = noteAt(event.target)
    if (id) options.open(id)
  })

  return {
    fit,
    draw(annotations, places, open) {
      opened = open
      if (hovered && !places.has(hovered)) hovered = null
      if (shown) layout(annotations, places)
      light()
    },
  }
}
