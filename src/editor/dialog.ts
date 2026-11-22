// A question that needs an answer before anything changes: a modal dialog in
// the editor's own style. The safe answer comes first and has the focus, so
// Enter or Escape never does the irreversible thing by accident; a click
// outside the dialog is a no too.
import { el, escapeHtml } from './dom.js'

export interface Confirmation {
  /** The question, as the dialog's title: "Delete “Plan”?". */
  title: string
  /** What a yes does, a paragraph each. */
  details?: string[]
  /** The button that does it: "Delete". */
  confirm: string
  /** The button that keeps things as they are. Default "Cancel". */
  cancel?: string
  /** Whether a yes destroys something: its button then shows in the colour for that. */
  danger?: boolean
}

let serial = 0

/** Asks inside `root`, so the dialog takes the editor's theme; true once the person confirms. */
export function confirmDialog(root: HTMLElement, question: Confirmation): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `galley-dialog-${++serial}`
    const details = question.details?.filter(Boolean) ?? []
    const dialog = el('dialog', { class: 'galley-dialog', 'aria-labelledby': `${id}-title`, ...(details.length ? { 'aria-describedby': `${id}-details` } : {}) },
      `<h2 class="galley-dialog-title" id="${id}-title">${escapeHtml(question.title)}</h2>`
      + (details.length ? `<div class="galley-dialog-details" id="${id}-details">${details.map((d) => `<p>${escapeHtml(d)}</p>`).join('')}</div>` : '')
      + '<div class="galley-dialog-actions">'
      + `<button type="button" class="galley-dialog-btn" data-answer="no">${escapeHtml(question.cancel ?? 'Cancel')}</button>`
      + `<button type="button" class="galley-dialog-btn ${question.danger ? 'is-danger' : 'is-primary'}" data-answer="yes">${escapeHtml(question.confirm)}</button>`
      + '</div>')
    let yes = false
    dialog.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-answer]')
      if (button) {
        yes = button.dataset.answer === 'yes'
        dialog.close()
        return
      }
      // The backdrop belongs to the dialog element, so a click there lands on it: outside its box, it is a no.
      const box = dialog.getBoundingClientRect()
      if (e.target === dialog && (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom)) dialog.close()
    })
    dialog.addEventListener('close', () => {
      dialog.remove()
      resolve(yes)
    })
    root.append(dialog)
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-answer="no"]')?.focus()
  })
}
