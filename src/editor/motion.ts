// Motion for text that arrives while someone reads it. Room opens for new
// lines as they fade in, a changed line eases to its new height while its text
// settles, and the room of lines that are gone closes as they fade out.
//
// Only what is on screen moves. A change above the first line on screen is
// made at once and the page scrolls by as much, so the reader's place stays
// where it was; a change far below the screen is simply there when they get
// to it. Marks drawn over the text are drawn where the text ends up and eased
// there along with it.
//
// How things move belongs to the stylesheet (galley.css: is-arriving,
// is-revised, is-closing, is-following, galley-ghost; --galley-dur-flow and its
// neighbours in tokens.css). With motion turned off nothing animates.
import type { TextPatch } from '../surface/surface.js'

/** The first line on screen before a change, and where it was. */
export interface Anchor {
  index: number
  top: number
}

export interface Motion {
  enabled(): boolean
  /** Where the reader is, read before the text changes. Null at the very top, where new text should be seen arriving. */
  anchor(): Anchor | null
  /** Keep the reader's place, draw the overlay where the text ends up (`overlay`), then move what is on screen. */
  play(patch: TextPatch, anchor: Anchor | null, overlay: () => void): void
  /** End any motion now, every line where it ends up. */
  finish(): void
}

export interface MotionOptions {
  root: HTMLElement
  scroller: HTMLElement
  page: HTMLElement
  doc: HTMLElement
  /** A layer over the page where lines that are gone fade out. */
  ghosts: HTMLElement
  /** Layers whose drawings follow the text (note marks, highlights). */
  follow(): HTMLElement[]
}

// Lines after this many arrive together rather than one after another.
const STAGGER_LIMIT = 12
// How far below the screen a change still moves, so text scrolled to mid-arrival is still arriving.
const BELOW = 160
// A safety net: anything still marked as moving after this long is put to rest.
const REST_MS = 3000

const FLOW_CLASSES = ['is-arriving', 'is-revised', 'is-settling', 'is-closing', 'is-following']
const FLOW_PROPS = ['--galley-flow-h', '--galley-flow-from', '--galley-flow-i', '--galley-flow-gap', '--galley-flow-dy']

export function createMotion(options: MotionOptions): Motion {
  const { root, scroller, page, doc, ghosts } = options
  const moving = new Set<HTMLElement>()
  let timer = 0
  let after: (() => void) | null = null

  function enabled(): boolean {
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    return getComputedStyle(root).getPropertyValue('--galley-ctl-motion').trim() !== '0'
  }

  function rest(el: HTMLElement): void {
    moving.delete(el)
    if (el.classList.contains('galley-ghost')) { el.remove(); return }
    el.classList.remove(...FLOW_CLASSES)
    for (const prop of FLOW_PROPS) el.style.removeProperty(prop)
  }

  function settled(): void {
    window.clearTimeout(timer)
    timer = 0
    const done = after
    after = null
    done?.()
  }

  function finish(): void {
    for (const el of [...moving]) rest(el)
    ghosts.replaceChildren()
    window.clearTimeout(timer)
    timer = 0
    after = null
  }

  // One listener for every moving element: an element rests once none of its animations is still running.
  root.addEventListener('animationend', (event) => {
    const el = event.target as HTMLElement
    if (!moving.has(el)) return
    if (el.getAnimations().some((a) => a.playState === 'running')) return
    rest(el)
    if (!moving.size) settled()
  })

  function anchor(): Anchor | null {
    if (scroller.scrollTop <= 0) return null
    const top = scroller.getBoundingClientRect().top
    const lines = doc.children
    let lo = 0
    let hi = lines.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (lines[mid].getBoundingClientRect().bottom > top) { found = mid; hi = mid - 1 } else lo = mid + 1
    }
    return found < 0 ? null : { index: found, top: lines[found].getBoundingClientRect().top }
  }

  function play(patch: TextPatch, from: Anchor | null, overlay: () => void): void {
    // The reader's place first: whatever changed above the line they were
    // looking at, that line stays where it was on screen.
    let anchorIndex = -1
    if (from) {
      anchorIndex = patch.map(from.index)
      const line = doc.children[anchorIndex]
      if (line) {
        const shift = line.getBoundingClientRect().top - from.top
        if (Math.abs(shift) >= 1) scroller.scrollTop += shift
      }
    }
    overlay()
    if (!enabled()) return

    // Read everything first, then write, so the page is laid out once.
    const pageTop = page.getBoundingClientRect().top
    const limit = scroller.getBoundingClientRect().bottom - pageTop + BELOW
    const below = (index: number, top: number, atAnchor = false) => (index > anchorIndex || (atAnchor && index === anchorIndex)) && top < limit
    const writes: (() => void)[] = []
    // Where the text below a change starts out: content from `top` down begins `dy` away and eases home.
    const regions: { top: number, dy: number, stagger: number }[] = []

    let stagger = 0
    for (const { line, index } of patch.inserted) {
      const top = line.offsetTop
      if (!below(index, top)) continue
      const height = line.offsetHeight
      const i = Math.min(stagger++, STAGGER_LIMIT)
      regions.push({ top: top + height, dy: -height, stagger: i })
      writes.push(() => {
        line.style.setProperty('--galley-flow-h', `${height}px`)
        line.style.setProperty('--galley-flow-i', String(i))
        line.classList.add('is-arriving')
        moving.add(line)
      })
    }
    for (const { line, index, height: before } of patch.revised) {
      const top = line.offsetTop
      if (!below(index, top, true)) continue
      const height = line.offsetHeight
      if (Math.abs(height - before) < 1) {
        writes.push(() => { line.classList.add('is-settling'); moving.add(line) })
        continue
      }
      regions.push({ top: top + height, dy: before - height, stagger: 0 })
      writes.push(() => {
        line.style.setProperty('--galley-flow-from', `${before}px`)
        line.style.setProperty('--galley-flow-h', `${height}px`)
        line.classList.add('is-revised')
        moving.add(line)
      })
    }
    for (const run of patch.removed) {
      const last = doc.lastElementChild as HTMLElement | null
      const top = run.next ? run.next.offsetTop : last ? last.offsetTop + last.offsetHeight : 0
      if (!below(run.index, top) || run.height < 1) continue
      // The lines that are gone, as they looked, fade where they stood while the room closes.
      const ghost = document.createElement('div')
      ghost.className = 'galley-ghost'
      ghost.style.top = `${top}px`
      ghost.style.setProperty('--galley-flow-from', `${run.height}px`)
      ghost.append(...run.lines)
      const next = run.next
      const margin = next ? parseFloat(getComputedStyle(next).marginTop) || 0 : 0
      if (next) regions.push({ top, dy: run.height, stagger: 0 })
      writes.push(() => {
        ghosts.append(ghost)
        moving.add(ghost)
        if (!next) return
        next.style.setProperty('--galley-flow-gap', `${margin + run.height}px`)
        next.classList.add('is-closing')
        moving.add(next)
      })
    }
    if (!writes.length) return

    // Marks over the text start where their text starts, and move with it.
    regions.sort((a, b) => a.top - b.top)
    for (const layer of options.follow()) {
      for (const mark of Array.from(layer.children) as HTMLElement[]) {
        const y = mark.offsetTop
        let dy = 0
        let longest = 0
        for (const r of regions) {
          if (r.top > y) break
          dy += r.dy
          longest = Math.max(longest, r.stagger)
        }
        if (Math.abs(dy) < 1) continue
        writes.push(() => {
          mark.style.setProperty('--galley-flow-dy', `${dy}px`)
          mark.style.setProperty('--galley-flow-i', String(longest))
          mark.classList.add('is-following')
          moving.add(mark)
        })
      }
    }

    for (const write of writes) write()
    // Once everything rests, the overlay is drawn once more from the page as it now is.
    after = overlay
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { for (const el of [...moving]) rest(el); settled() }, REST_MS)
  }

  return { enabled, anchor, play, finish }
}
