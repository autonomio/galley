export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;'
      : c === '<' ? '&lt;'
        : c === '>' ? '&gt;'
          : c === '"' ? '&quot;'
            : '&#39;'
  ))
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  html = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  if (html) node.innerHTML = html
  return node
}

/** Play the reveal animation once (the stylesheet owns what it looks like). */
export function reveal(node: HTMLElement): void {
  node.classList.remove('galley-reveal')
  void node.offsetWidth
  node.classList.add('galley-reveal')
}

/** A minimal typed event emitter. */
export class Emitter<Events extends object> {
  private readonly handlers = new Map<keyof Events, Set<(payload: never) => void>>()

  on<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(type)
    if (!set) { set = new Set(); this.handlers.set(type, set) }
    set.add(handler as (payload: never) => void)
    return () => { set.delete(handler as (payload: never) => void) }
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      try {
        (handler as (payload: Events[K]) => void)(payload)
      } catch (error) {
        console.error(`[galley] a ${String(type)} handler failed:`, error)
      }
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}
