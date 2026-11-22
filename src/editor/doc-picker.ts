// The document picker: the open document's title with ▾, and a menu of every
// document grouped by recency, each with its age and a button that deletes it.
import { groupBucket, relTime } from '../core/time.js'
import { UNTITLED } from '../markdown/title.js'
import type { DocSummary } from '../types.js'
import { el, escapeHtml, reveal } from './dom.js'
import { icons } from './icons.js'

export interface PickerState {
  docs: DocSummary[]
  current: string | null
  loaded: boolean
  error: boolean
}

export interface DocPicker {
  readonly element: HTMLElement
  render(state: PickerState): void
  open(): void
  close(): void
  isOpen(): boolean
  destroy(): void
}

// The trigger shares its row with the toolbar; long titles truncate here and
// show whole in the menu and the tooltip.
function truncate(s: string): string {
  return s.length > 28 ? s.slice(0, 27).trimEnd() + '…' : s
}

export function createDocPicker(handlers: { select(slug: string): void, opening(): void, remove?(slug: string): void }): DocPicker {
  const element = el('div', { class: 'galley-picker' })
  const trigger = el('button', {
    type: 'button',
    class: 'galley-picker-trigger',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
  }, `<span class="galley-picker-title">${UNTITLED}</span><span class="galley-picker-chevron" aria-hidden="true">▾</span>`)
  const titleEl = trigger.querySelector<HTMLElement>('.galley-picker-title')!
  const menu = el('div', { class: 'galley-picker-menu', role: 'menu', 'aria-label': 'Documents' })
  menu.hidden = true
  element.append(trigger, menu)

  let state: PickerState = { docs: [], current: null, loaded: false, error: false }
  let markup = ''

  function renderMenu(): void {
    let next: string
    if (!state.docs.length) {
      const message = state.error ? 'Could not load documents. Reopen to retry.'
        : !state.loaded ? 'Loading documents…' : 'No documents yet.'
      next = `<div class="galley-picker-empty" role="status">${message}</div>`
    } else {
      const parts: string[] = state.error
        ? ['<div class="galley-picker-empty" role="status">Could not refresh documents. Reopen to retry.</div>']
        : []
      let bucket = ''
      for (const d of state.docs) {
        const b = groupBucket(d.updated_at)
        if (b !== bucket) { parts.push(`<h3 class="galley-picker-bucket">${escapeHtml(b)}</h3>`); bucket = b }
        const title = d.title || UNTITLED
        const active = d.slug === state.current ? ' is-active' : ''
        parts.push(`<div class="galley-picker-row${active}" role="none">`
          + `<button type="button" class="galley-picker-item${active}" role="menuitem" data-slug="${escapeHtml(d.slug)}" title="${escapeHtml(title)}">`
          + `<span class="galley-picker-item-title">${escapeHtml(title)}</span>`
          + `<span class="galley-picker-item-time">${escapeHtml(relTime(d.updated_at))}</span></button>`
          + (handlers.remove ? `<button type="button" class="galley-picker-delete" data-delete="${escapeHtml(d.slug)}" aria-label="${escapeHtml(`Delete “${title}”`)}" title="${escapeHtml(`Delete “${title}”`)}">${icons.trash}</button>` : '')
          + '</div>')
      }
      next = parts.join('')
    }
    if (next === markup) return
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.slug
    markup = next
    menu.innerHTML = next
    if (focused) menu.querySelector<HTMLElement>(`[data-slug="${CSS.escape(focused)}"]`)?.focus()
  }

  function renderTitle(): void {
    const doc = state.docs.find((d) => d.slug === state.current)
    const full = doc?.title || UNTITLED
    titleEl.textContent = truncate(full)
    trigger.title = full
  }

  // A dialog asking about a delete answers for itself: the menu stays open behind it, so several go in a row.
  const inDialog = (target: EventTarget | null) => !!(target as HTMLElement | null)?.closest?.('dialog')

  function onOutside(e: MouseEvent): void {
    if (element.contains(e.target as Node) || inDialog(e.target)) return
    close()
  }

  function onKey(e: KeyboardEvent): void {
    if (inDialog(e.target)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      trigger.focus()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = Array.from(menu.querySelectorAll<HTMLElement>('.galley-picker-item'))
      if (!items.length) return
      e.preventDefault()
      const at = items.indexOf(document.activeElement as HTMLElement)
      const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1)
      items[next].focus()
    }
  }

  function open(): void {
    handlers.opening()
    renderMenu()
    menu.hidden = false
    reveal(menu)
    trigger.setAttribute('aria-expanded', 'true')
    // Deferred so the click that opened the menu doesn't close it.
    setTimeout(() => {
      document.addEventListener('click', onOutside)
      document.addEventListener('keydown', onKey)
    }, 0)
  }

  function close(): void {
    menu.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onOutside)
    document.removeEventListener('keydown', onKey)
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu.hidden) open()
    else close()
  })
  menu.addEventListener('click', (e) => {
    const remove = (e.target as HTMLElement).closest<HTMLElement>('.galley-picker-delete')
    if (remove) {
      if (remove.dataset.delete) handlers.remove?.(remove.dataset.delete)
      return
    }
    const item = (e.target as HTMLElement).closest<HTMLElement>('.galley-picker-item')
    if (!item) return
    const slug = item.dataset.slug || ''
    close()
    if (slug && slug !== state.current) handlers.select(slug)
  })

  return {
    element,
    render(next) {
      state = next
      renderTitle()
      if (!menu.hidden) renderMenu()
    },
    open,
    close,
    isOpen: () => !menu.hidden,
    destroy: close,
  }
}
