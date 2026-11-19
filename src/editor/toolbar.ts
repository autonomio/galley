// The header's action buttons. Built-in and host actions are the same shape,
// so the toolbar is just a list rendered in order.
import { el, escapeHtml } from './dom.js'
import { attachTooltip } from './tooltip.js'

export interface ToolbarAction<Context> {
  id: string
  /** Accessible name, and the first line of the tooltip. */
  label: string
  /** What the control does, in a sentence: shown under the label when the pointer rests on it. */
  description?: string
  /** Trusted SVG markup. */
  icon: string
  /** Shown after the label in the tooltip, e.g. `⌘N`. */
  shortcut?: string
  /** Rendered as a toggle, pressed while this returns true. */
  pressed?(context: Context): boolean
  /** The icon while pressed. */
  pressedIcon?: string
  disabled?(context: Context): boolean
  /** Hover in the failure colour: for destructive actions. */
  danger?: boolean
  /** Always shown, even in writer mode. */
  keepInWriterMode?: boolean
  run(context: Context, button: HTMLButtonElement): void | Promise<void>
}

export interface Toolbar {
  readonly element: HTMLElement
  button(id: string): HTMLButtonElement | null
  update(): void
}

export function createToolbar<Context>(actions: ToolbarAction<Context>[], context: Context): Toolbar {
  const element = el('div', { class: 'galley-bar-left', role: 'toolbar', 'aria-label': 'Document' })
  const buttons = new Map<string, HTMLButtonElement>()

  for (const action of actions) {
    const button = el('button', {
      type: 'button',
      class: `galley-bar-btn${action.danger ? ' is-danger' : ''}${action.keepInWriterMode ? ' is-kept' : ''}`,
      'data-action': action.id,
      'aria-label': action.label,
    }, action.icon)
    attachTooltip(button, () => ({ label: action.label, shortcut: action.shortcut, description: action.description }))
    button.addEventListener('click', () => {
      if (button.disabled) return
      Promise.resolve()
        .then(() => action.run(context, button))
        .catch((error) => console.error(`[galley] action ${action.id} failed:`, error))
        .finally(update)
    })
    buttons.set(action.id, button)
    element.appendChild(button)
  }

  function update(): void {
    for (const action of actions) {
      const button = buttons.get(action.id)!
      if (action.pressed) {
        const on = action.pressed(context)
        button.setAttribute('aria-pressed', on ? 'true' : 'false')
        const icon = on && action.pressedIcon ? action.pressedIcon : action.icon
        if (button.dataset.icon !== (on ? 'pressed' : 'rest')) {
          button.dataset.icon = on ? 'pressed' : 'rest'
          button.innerHTML = icon
        }
      }
      if (action.disabled) button.disabled = action.disabled(context)
    }
  }

  update()
  return { element, button: (id) => buttons.get(id) ?? null, update }
}

/** Swap a button's icon to a check for a moment, as confirmation. */
export function confirmOn(button: HTMLButtonElement, check: string): void {
  const original = button.innerHTML
  button.innerHTML = check
  button.classList.add('is-done')
  window.setTimeout(() => {
    button.classList.remove('is-done')
    button.innerHTML = original
  }, 1200)
}

export { escapeHtml }
