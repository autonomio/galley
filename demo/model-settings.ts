import type { ModelCatalog, Place, Places, Provider, Slot } from '../src/engine/model-catalog.js'
import './model-settings.css'

type Change = { slots: ModelCatalog['slots'] } | { place: Place; slot: Places[Place] }
interface Settings extends ModelCatalog {
  revision: string
  canary: string
  roles: { key: Place; label: string; description: string }[]
  accounts: { provider: Provider; name: string; login: string }[]
}
type Reply = Settings & { error?: string; current?: Settings; identity?: string }

const URL_PATH = '/api/galley-models'
const SLOTS = { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary' } as const
const slots = Object.keys(SLOTS) as Slot[]

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

function button(label: string, run: (button: HTMLButtonElement) => void, className = 'gms-ghost'): HTMLButtonElement {
  const node = element('button', className, label)
  node.type = 'button'
  node.addEventListener('click', () => run(node))
  return node
}

async function request(path = '', method = 'GET', body?: unknown): Promise<{ response: Response; data: Reply }> {
  const response = await fetch(URL_PATH + path, {
    method, cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  return { response, data: await response.json() as Reply }
}

export function mountModelSettings(root: HTMLElement, back: string): void {
  const nav = element('nav', 'gms-nav')
  nav.setAttribute('aria-label', 'Settings sections')
  const find = element('input', 'gms-find')
  find.type = 'search'
  find.placeholder = 'Find a setting'
  find.setAttribute('aria-label', find.placeholder)
  const section = element('a', 'gms-go', 'Models')
  section.href = location.href
  section.setAttribute('aria-current', 'page')
  nav.append(find, section)

  const content = element('div', 'gms-main')
  const column = element('div', 'gms-col')
  const head = element('header', 'gms-head')
  const returnLink = element('a', 'gms-back', '← Back to Galley')
  returnLink.href = back
  head.append(returnLink, element('h1', '', 'Models'), element('p', '', 'The three models, where each one runs, and the catalog they come from.'))
  const body = element('div', 'gms-body')
  column.append(head, body)
  content.append(column)
  root.append(nav, content)

  let known: Settings
  const statuses = new Map<string, HTMLElement>()
  const expiry = new Map<string, ReturnType<typeof setTimeout>>()
  let busy = false
  let checking = false

  function group(label: string): HTMLElement {
    const node = element('section', 'gms-group')
    node.append(element('h2', '', label))
    body.append(node)
    return node
  }

  function row(parent: HTMLElement, key: string, label: string, detail: string, wide = false) {
    const node = element('div', `gms-row${wide ? ' is-wide' : ''}`)
    node.dataset.setting = key
    const description = element('div', 'gms-label')
    description.append(element('h3', '', label), element('p', '', detail))
    const control = element('div', 'gms-control')
    let status = statuses.get(key)
    if (!status) {
      status = element('div', 'gms-status')
      status.setAttribute('role', 'status')
      statuses.set(key, status)
    }
    node.append(description, control, status)
    parent.append(node)
    return { control, status }
  }

  function filter(): void {
    const query = find.value.trim().toLowerCase()
    for (const row of body.querySelectorAll<HTMLElement>('[data-setting]')) {
      row.hidden = !!query && !row.textContent?.toLowerCase().includes(query)
    }
    for (const group of body.querySelectorAll<HTMLElement>('.gms-group')) {
      group.hidden = !!query && !group.querySelector('[data-setting]:not([hidden])')
    }
  }

  find.addEventListener('input', filter)
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement)?.matches('input, textarea, select, [contenteditable]')) return
    event.preventDefault()
    find.focus()
  })

  function notice(key: string, message: string, tone = ''): HTMLElement {
    const status = statuses.get(key)!
    clearTimeout(expiry.get(key))
    status.className = `gms-status ${tone}`
    status.textContent = message
    return status
  }

  async function save(key: string, change: Change, before?: Change): Promise<void> {
    if (busy) return
    busy = true
    const focus = (document.activeElement as HTMLElement)?.id
    const controls = [...body.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('.gms-seg button, .gms-select select')]
    controls.forEach((control) => { control.disabled = true })
    notice(key, 'Saving…')
    try {
      const { response, data } = await request('', 'PUT', { revision: known.revision, ...change })
      if (response.status === 409 && data.current) {
        const status = notice(key, data.error ?? 'The settings changed.', 'is-error')
        known = data.current
        status.append(
          button('Save mine', () => {
            void save(key, change, 'slots' in change ? { slots: known.slots } : { place: change.place, slot: known.places[change.place] })
          }, 'gms-link'),
          button('Use theirs', () => { notice(key, 'Read the current settings.'); render(focus) }, 'gms-link'),
        )
        render(focus)
        return
      }
      if (!response.ok) throw new Error(data.error ?? 'The setting could not be saved.')
      known = data
      render(focus)
      const status = notice(key, 'Saved · from the next paper', 'is-saved')
      if (before) {
        const undo = button('Undo', () => void save(key, before), 'gms-link')
        status.append(undo)
        expiry.set(key, setTimeout(() => undo.remove(), 8000))
      }
    } catch (error) {
      notice(key, (error as Error).message, 'is-error')
      render(focus)
    } finally {
      busy = false
      controls.forEach((control) => { control.disabled = false })
    }
  }

  async function refresh(control: HTMLButtonElement): Promise<void> {
    if (checking) return
    checking = true
    control.disabled = true
    notice('catalog', 'Checking model catalogs…')
    try {
      const { response, data } = await request('/refresh', 'POST', {})
      if (!response.ok) throw new Error(data.error ?? 'The catalog could not be checked.')
      const added = data.models.filter((model) => !known.models.some((entry) => entry.identity === model.identity)).length
      // A save completing while this request was in flight may be newer than the report.
      const latest = await request()
      if (!latest.response.ok) throw new Error(latest.data.error ?? 'The catalog could not be read.')
      known = latest.data
      notice('catalog', added ? `Checked · ${added} new model${added === 1 ? '' : 's'}` : 'Checked')
      render(control.id)
    } catch (error) {
      notice('catalog', (error as Error).message, 'is-error')
    } finally {
      checking = false
      body.querySelector<HTMLButtonElement>('#gms-check')!.disabled = false
    }
  }

  function render(focus?: string): void {
    body.replaceChildren()
    const top = row(group('The three models'), 'slots', 'Models', 'Chosen once. Changing a slot changes every role that uses it.', true)
    const grid = element('div', 'gms-grid')
    for (const slot of slots) {
      const field = element('div', 'gms-slot')
      const label = element('label', 'gms-micro', SLOTS[slot])
      label.htmlFor = `gms-${slot}`
      const wrap = element('span', 'gms-select')
      const select = element('select')
      select.id = label.htmlFor
      select.setAttribute('aria-label', `${SLOTS[slot]} model`)
      for (const model of known.models) select.add(new Option(model.identity, model.identity))
      select.value = known.slots[slot]
      wrap.append(select)
      select.addEventListener('change', () => {
        const chosen = select.value
        select.value = known.slots[slot]
        void save('slots', { slots: { ...known.slots, [slot]: chosen } }, { slots: known.slots })
      })
      field.append(label, wrap, button(`Test ${SLOTS[slot].toLowerCase()} model`, async (control) => {
        const identity = known.slots[slot]
        control.disabled = true
        notice('slots', `Testing ${identity}…`)
        try {
          const { response, data } = await request('/test', 'POST', { identity })
          if (!response.ok || data.identity !== identity) throw new Error(data.error ?? 'The provider did not confirm the selected model.')
          notice('slots', `${identity} answered`, 'is-saved')
        } catch (error) { notice('slots', (error as Error).message, 'is-error') }
        finally { control.disabled = false }
      }, 'gms-link'))
      grid.append(field)
    }
    top.control.append(grid)

    const roles = group('Where each one runs')
    for (const role of known.roles) {
      const { control } = row(roles, role.key, role.label, role.description)
      const current = known.places[role.key]
      const choices = element('div', 'gms-seg')
      choices.setAttribute('role', 'group')
      choices.setAttribute('aria-label', role.label)
      const available = role.key === 'adjudicator' ? [...slots, 'independent'] as const : slots
      for (const slot of available) {
        const option = button(slot === 'independent' ? 'Independent' : SLOTS[slot], () => {
          if (current !== slot) void save(role.key, { place: role.key, slot }, { place: role.key, slot: current })
        }, '')
        option.id = `gms-${role.key}-${slot}`
        option.setAttribute('aria-pressed', String(current === slot))
        choices.append(option)
      }
      control.append(choices, element('span', 'gms-note', current === 'independent' ? 'Third model from the three slots' : known.slots[current]))
    }

    const canary = row(group('Set by Canary'), 'canary', 'Systematic literature review', 'Canary uses the same model for its research and audit sessions.')
    canary.control.append(element('span', 'gms-note', known.canary))

    const catalog = group('Catalog')
    const catalogRow = row(catalog, 'catalog', 'Model catalog', 'Every model choice comes from this list. Check now reads the catalogs of the provider CLIs on this machine.')
    const line = element('div', 'gms-line')
    const checked = known.checked ? `checked ${new Date(known.checked.at).toLocaleString()}` : 'not checked yet'
    const check = button('Check now', (control) => void refresh(control))
    check.id = 'gms-check'
    check.disabled = checking
    line.append(element('span', 'gms-note', `${known.models.length} models · ${checked}`), check)
    catalogRow.control.append(line)
    for (const { provider, name, login } of known.accounts) {
      const account = row(catalog, provider, name, 'Connect in a terminal on the machine running Galley.')
      account.control.append(element('code', 'gms-code', login))
      if (known.checked) account.control.append(element('span', 'gms-note', known.checked.providers[provider]))
    }

    filter()
    if (focus) document.getElementById(focus)?.focus({ preventScroll: true })
  }

  async function open(): Promise<void> {
    body.replaceChildren(element('p', 'gms-note', 'Loading…'))
    try {
      const { response, data } = await request()
      if (!response.ok) throw new Error(data.error ?? 'The model catalog could not be read.')
      known = data
      render()
    } catch (error) {
      body.replaceChildren(element('p', 'gms-status is-error', (error as Error).message), button('Retry', () => void open()))
    }
  }
  void open()
}
