// A control's name and what it does, shown when the pointer rests on it for
// half a second, or when keyboard focus reaches it. Once one is showing,
// moving to the next control shows its tip at once.
import { el } from './dom.js'

export interface Tip {
  label: string
  shortcut?: string
  description?: string
}

const DELAY = 500
/** After a tip hides, the next one within this window shows without waiting. */
const WARM = 400

let tooltip: HTMLElement | null = null
let timer = 0
let current: HTMLElement | null = null
let hiddenAt = 0
let serial = 0

function element(root: HTMLElement): HTMLElement {
  if (!tooltip || !tooltip.isConnected || tooltip.parentElement !== root) {
    tooltip?.remove()
    tooltip = el('div', { class: 'galley-tooltip', role: 'tooltip', id: `galley-tooltip-${++serial}` })
    root.appendChild(tooltip)
  }
  return tooltip
}

function show(button: HTMLElement, tip: Tip): void {
  const root = button.closest<HTMLElement>('.galley')
  if (!root || !button.isConnected) return
  const box = element(root)
  box.replaceChildren(
    el('span', { class: 'galley-tooltip-label' }, tip.label),
    ...(tip.shortcut ? [el('span', { class: 'galley-tooltip-key' }, tip.shortcut)] : []),
    ...(tip.description ? [el('span', { class: 'galley-tooltip-what' }, tip.description)] : []),
  )
  // Below the control, kept inside the window.
  const at = button.getBoundingClientRect()
  box.style.left = '0px'
  box.style.top = '0px'
  box.classList.add('is-shown')
  const size = box.getBoundingClientRect()
  const gap = 6
  const left = Math.max(gap, Math.min(at.left, window.innerWidth - size.width - gap))
  const below = at.bottom + gap
  const top = below + size.height > window.innerHeight - gap ? Math.max(gap, at.top - size.height - gap) : below
  box.style.left = `${Math.round(left)}px`
  box.style.top = `${Math.round(top)}px`
  button.setAttribute('aria-describedby', box.id)
  current = button
}

function hide(): void {
  window.clearTimeout(timer)
  if (current) current.removeAttribute('aria-describedby')
  if (tooltip?.classList.contains('is-shown')) hiddenAt = Date.now()
  tooltip?.classList.remove('is-shown')
  current = null
}

/** Give a control its tip. `tip` is read when it shows, so a label that changes stays current. */
export function attachTooltip(button: HTMLElement, tip: () => Tip): void {
  const schedule = () => {
    window.clearTimeout(timer)
    const warm = Date.now() - hiddenAt < WARM || !!current
    timer = window.setTimeout(() => show(button, tip()), warm ? 0 : DELAY)
  }
  button.addEventListener('pointerenter', schedule)
  button.addEventListener('pointerleave', hide)
  button.addEventListener('focus', () => { if (button.matches(':focus-visible')) schedule() })
  button.addEventListener('blur', hide)
  // Acting on a control answers the question the tip was for.
  button.addEventListener('pointerdown', () => { hide(); hiddenAt = 0 })
  button.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide() })
}
