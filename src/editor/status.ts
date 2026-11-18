// The status line under the page (words · save state), and the built-in
// notice stack a host can replace with its own (EditorOptions.notify).
import type { Notice, SaveState } from './session.js'
import { el, escapeHtml, reveal } from './dom.js'
import { icons } from './icons.js'

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  editing: 'Editing…',
  saving: 'Saving…',
  saved: 'Saved',
  unsaved: 'Not saved',
}

export interface StatusLine {
  readonly element: HTMLElement
  setState(state: SaveState): void
  setWords(words: number): void
}

export function createStatusLine(): StatusLine {
  const element = el('footer', { class: 'galley-status' })
  const words = el('span', { class: 'galley-status-words' })
  const save = el('span', { class: 'galley-status-save', role: 'status', 'aria-live': 'polite' })
  element.append(words, save)
  let savedAt: Date | null = null
  return {
    element,
    setState(state) {
      if (state === 'saved') savedAt = new Date()
      save.dataset.state = state
      save.textContent = state === 'saved' && savedAt
        ? `Saved ${savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : SAVE_LABEL[state]
    },
    setWords(n) {
      words.textContent = n === 1 ? '1 word' : `${n.toLocaleString()} words`
    },
  }
}

export interface NoticeStack {
  readonly element: HTMLElement
  show(notice: Notice): void
}

export function createNoticeStack(): NoticeStack {
  const element = el('div', { class: 'galley-notices', role: 'region', 'aria-label': 'Editor notices' })
  const bySource = new Map<string, HTMLElement>()
  return {
    element,
    show(notice) {
      const existing = bySource.get(notice.source)
      if (!notice.message) {
        existing?.remove()
        bySource.delete(notice.source)
        return
      }
      const item = existing ?? el('div', { class: 'galley-notice', role: 'alert' })
      item.dataset.level = notice.level ?? 'error'
      item.innerHTML = `<p>${escapeHtml(notice.message)}</p><button type="button" class="galley-notice-close" aria-label="Dismiss" title="Dismiss">${icons.close}</button>`
      item.querySelector('button')!.addEventListener('click', () => {
        item.remove()
        bySource.delete(notice.source)
      })
      if (!existing) {
        bySource.set(notice.source, item)
        element.appendChild(item)
        reveal(item)
      }
    },
  }
}
