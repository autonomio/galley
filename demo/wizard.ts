// From a seed document to a paper, in four steps: the seed, the materials the
// paper draws on, the settings that change the outcome, and an exact account of
// what happens and what leaves this machine. Nothing starts until Start.
import type { EditorAction } from '../src/index.js'

interface Seat { family: string; name: string; model: string }
interface Context {
  openalexKey: boolean
  seats: Record<'author' | 'checker' | 'challenger' | 'verifier', Seat>
  referees: string[]
  defaults: { venue: string; words: number; rounds: number; dial: string; citations: string; literatureReview?: boolean; simulation?: boolean }
  review?: { research: string; audit: string; papers: number }
}
interface Item { name: string; kind: 'dataset' | 'document' | 'link'; url?: string; file?: File; detail: string; private: boolean }

const STEPS = ['Seed', 'Materials', 'Settings', 'Start'] as const
const DATASET = /\.(csv|tsv|json|xlsx)$/i

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'text') node.textContent = String(value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value as EventListener)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children) if (child) node.append(child)
  return node
}

const n = (x: number) => x.toLocaleString('en-US')
const minutes = (m: number) => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`

/** Rows and columns of a dataset, read in the browser so the list can say what it holds. */
async function describe(file: File): Promise<string> {
  const size = file.size > 1e6 ? `${(file.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1e3))} kB`
  if (!DATASET.test(file.name)) return `${file.name.split('.').pop()?.toUpperCase() ?? 'File'} · ${size}`
  if (/\.xlsx$/i.test(file.name)) return `Excel workbook · ${size} · each sheet's data columns become a dataset`
  try {
    const text = await file.text()
    if (/\.json$/i.test(file.name)) {
      const data = JSON.parse(text)
      const rows = Array.isArray(data) ? data : data?.data ?? []
      return `${n(rows.length)} rows · ${n(Object.keys(rows[0] ?? {}).length)} columns · ${size}`
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    const delimiter = /\.tsv$/i.test(file.name) || lines[0]?.includes('\t') ? '\t' : ','
    return `${n(Math.max(0, lines.length - 1))} rows · ${n((lines[0] ?? '').split(delimiter).length)} columns · ${size}`
  } catch {
    return size
  }
}

const base64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})

export function openPaperWizard(options: { slug: string; title: string; text: string; onStart?: (paper: string) => void }): void {
  const { slug, title, text } = options
  const words = text.split(/\s+/).filter(Boolean).length
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length
  const items: Item[] = []
  let step = 0
  let context: Context | null = null
  const settings = { author: '', affiliation: '', venue: 'preprint (arXiv)', words: 7000, rounds: 2, dial: 'autonomous', citations: 'auto', literatureReview: false, reviewRole: 'supporting', simulation: false, simulationRole: 'supporting' }

  const dialog = h('dialog', { class: 'gw', 'aria-labelledby': 'gw-title' })
  const trail = h('ol', { class: 'gw-trail' })
  const body = h('div', { class: 'gw-body' })
  const back = h('button', { type: 'button', class: 'gw-btn', text: 'Back', onclick: () => go(step - 1) })
  const next = h('button', { type: 'button', class: 'gw-btn gw-btn--primary', onclick: () => step < STEPS.length - 1 ? go(step + 1) : start() })
  const hint = h('span', { class: 'gw-hint', text: 'Esc closes. Nothing starts until you press Start.' })
  dialog.append(h('header', { class: 'gw-head' }, trail), body, h('footer', { class: 'gw-foot' }, hint, h('div', { class: 'gw-actions' }, back, next)))
  dialog.addEventListener('close', () => dialog.remove())
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close() })
  document.body.append(dialog)
  dialog.showModal()

  fetch('/api/galley-papers/_context').then((r) => r.ok ? r.json() : null).then((c: Context | null) => {
    context = c
    if (c) Object.assign(settings, { venue: c.defaults.venue, words: c.defaults.words, rounds: c.defaults.rounds, dial: c.defaults.dial, citations: c.defaults.citations, literatureReview: !!c.defaults.literatureReview, simulation: !!c.defaults.simulation })
    render()
  }).catch(() => render())

  function go(to: number): void {
    step = Math.max(0, Math.min(STEPS.length - 1, to))
    render()
  }

  function render(): void {
    trail.replaceChildren(...STEPS.map((name, i) => h('li', { class: i === step ? 'is-current' : i < step ? 'is-done' : '', 'aria-current': i === step ? 'step' : undefined },
      h('span', { class: 'gw-num', text: String(i + 1) }), name)))
    back.hidden = step === 0
    next.textContent = step === STEPS.length - 1 ? 'Start the paper' : `Next: ${STEPS[step + 1]}`
    body.replaceChildren(...[seedStep, materialsStep, settingsStep, startStep][step]().filter((x): x is Node => !!x))
    body.scrollTop = 0
    const first = body.querySelector<HTMLElement>('input, button, select, textarea')
    ;(step === 0 ? next : first ?? next).focus()
  }

  // ---------------------------------------------------------------- 1. seed
  function seedStep(): (Node | null)[] {
    const preview = text.length > 700 ? `${text.slice(0, 700).trimEnd()} …` : text
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'Your seed' }),
      h('p', { class: 'gw-lead', text: `The paper starts from your words in “${title}”. Nothing is added to them: galley challenges the idea, researches it and writes from them.` }),
      h('p', { class: 'gw-facts' }, h('span', { class: 'gw-mono', text: n(words) }), ' words · ', h('span', { class: 'gw-mono', text: n(paragraphs) }), ` paragraph${paragraphs === 1 ? '' : 's'}`),
      h('blockquote', { class: 'gw-quote', text: preview }),
      h('p', { class: 'gw-note', text: `The paper appears in your documents as “${slug}-paper” as soon as it starts, and grows there as it is written.` }),
    ]
  }

  // ---------------------------------------------------------------- 2. materials
  function materialsStep(): (Node | null)[] {
    const picker = h('input', { type: 'file', multiple: true, class: 'gw-file', 'aria-label': 'Choose files', accept: '.csv,.tsv,.json,.xlsx,.md,.txt,.tex,.docx,.odt,.html,.pdf' })
    picker.addEventListener('change', () => add([...(picker.files ?? [])]))
    const drop = h('label', { class: 'gw-drop' },
      picker,
      h('span', { class: 'gw-drop-main', text: 'Drop files here, or choose files' }),
      h('span', { class: 'gw-drop-sub', text: 'Datasets: CSV, TSV, JSON · Documents: Markdown, text, Word, PDF' }))
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over') })
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'))
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); add([...(e.dataTransfer?.files ?? [])]) })
    const url = h('input', { type: 'url', class: 'gw-input', placeholder: 'https://', 'aria-label': 'Link' })
    const addLink = () => {
      const value = url.value.trim()
      if (!/^https?:\/\/\S+\.\S+/i.test(value)) { url.setCustomValidity('A full address, starting with http:// or https://'); url.reportValidity(); return }
      url.setCustomValidity('')
      items.push({ name: value, kind: 'link', url: value, detail: 'Read once, when the paper starts', private: false })
      render()
    }
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLink() } })
    const list = items.length
      ? h('ul', { class: 'gw-list' }, ...items.map((item, i) => h('li', { class: 'gw-row' },
        h('span', { class: `gw-kind gw-kind--${item.kind}`, 'aria-hidden': 'true' }),
        h('span', { class: 'gw-row-main' }, h('span', { class: 'gw-mono gw-row-name', text: item.name }), h('span', { class: 'gw-row-detail', text: item.detail })),
        item.kind === 'dataset' ? segmented([['Private', true], ['Shared', false]], item.private, (v) => { item.private = v; render() }, `Who may read ${item.name}`) : h('span', { class: 'gw-row-kind', text: item.kind }),
        h('button', { type: 'button', class: 'gw-x', 'aria-label': `Remove ${item.name}`, text: '×', onclick: () => { items.splice(i, 1); render() } }))))
      : h('p', { class: 'gw-empty', text: 'No materials. The paper will rest on your seed and the literature.' })
    const privateSets = items.filter((i) => i.kind === 'dataset' && i.private).length
    const sharedSets = items.filter((i) => i.kind === 'dataset' && !i.private).length
    const read = items.filter((i) => i.kind !== 'dataset').length
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'What the paper draws on' }),
      h('p', { class: 'gw-lead', text: 'Besides the literature, a paper can rest on your own material: data, notes, drafts, pages.' }),
      drop,
      h('div', { class: 'gw-linkrow' }, url, h('button', { type: 'button', class: 'gw-btn', text: 'Add link', onclick: addLink })),
      list,
      privateSets ? h('p', { class: 'gw-note' }, h('strong', { text: 'Private datasets stay on this machine. ' }), 'The models see only a summary of each column and the results galley computes here, and every number the paper states about your data comes from those results.') : null,
      sharedSets ? h('p', { class: 'gw-note', text: 'Shared datasets: the models also read their first 15 rows.' }) : null,
      read ? h('p', { class: 'gw-note', text: 'Documents and links are read by the models that write and review the paper.' }) : null,
    ]
  }

  async function add(files: File[]): Promise<void> {
    for (const file of files) {
      if (file.size > 50e6) { alert(`${file.name} is larger than 50 MB.`); continue }
      const kind = DATASET.test(file.name) ? 'dataset' : 'document'
      items.push({ name: file.name, kind, file, detail: await describe(file), private: kind === 'dataset' })
    }
    render()
  }

  // ---------------------------------------------------------------- 3. settings
  function settingsStep(): (Node | null)[] {
    const field = (label: string, control: Node, help?: string) => h('div', { class: 'gw-field' }, h('div', { class: 'gw-label', text: label }), control, help ? h('p', { class: 'gw-help', text: help }) : null)
    const input = (key: 'author' | 'affiliation' | 'venue', placeholder: string, list?: string) => {
      const el = h('input', { class: 'gw-input', value: settings[key], placeholder, 'aria-label': placeholder, ...(list ? { list } : {}) })
      el.addEventListener('input', () => { settings[key] = el.value })
      return el
    }
    const seats = context?.seats
    const seatRow = (seat: string, s?: Seat) => h('tr', {}, h('th', { text: seat }), h('td', { text: s?.name ?? '—' }), h('td', { class: 'gw-mono', text: s?.model ?? '' }))
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'How the paper is made' }),
      field('Author', h('div', { class: 'gw-pair' }, input('author', 'Name'), input('affiliation', 'Affiliation')), 'Set in the byline when the paper is typeset; never sent to a model.'),
      field('Venue', h('span', {}, input('venue', 'Venue', 'gw-venues'), h('datalist', { id: 'gw-venues' }, ...['preprint (arXiv)', 'preprint (bioRxiv)', 'preprint (medRxiv)', 'preprint (SSRN)', 'preprint (EdArXiv)', 'journal article'].map((v) => h('option', { value: v })))), 'Shapes the outline and how the referees read the paper.'),
      field('Length', segmented([3000, 5000, 7000, 9000].map((w) => [`${n(w)} words`, w] as [string, number]), settings.words, (v) => { settings.words = v; render() }, 'Length')),
      field('Also include', h('div', { class: 'gw-choices' }, toggle('literatureReview', 'Systematic literature review', `Canary searches OpenAlex, screens the candidates, reads at least ${context?.review?.papers ?? 50} full papers and has every finding audited by a second model.`, 'A review section after the introduction, beside the paper\'s own contribution; it runs alongside the other steps.', 'The paper is the systematic review: its thesis and contribution are what the review establishes, and the plan waits for the review to finish.'), toggle('simulation', 'Monte Carlo simulation', 'The author designs the simulation the argument needs (plain, correlated or sequential Monte Carlo) and galley runs it on this machine; every simulated number in the paper is filled in from the run.', 'Its results support the paper\'s own contribution where they help.', 'The paper\'s thesis rests on what the simulation shows: its contribution claims are claims about the results, and the paper is built around the model.'))),
      field('Review', segmented([['1 round', 1], ['2 rounds', 2]], settings.rounds, (v) => { settings.rounds = v; render() }, 'Referee rounds'), `Four referee seats a round: ${context?.referees.join(', ') ?? 'methods, field, citations, editor'}, from the families that did not write the text. About 50 min a round.`),
      field('Your part', choice('dial', [
        ['autonomous', 'Autonomous', 'Nothing waits for you. You review the finished paper.'],
        ['assisted', 'Assisted', 'Sources for load-bearing claims, and answers to critical findings, wait for you.'],
        ['propose', 'Propose', 'Every answer to a referee waits for your Accept in the editor.'],
      ])),
      field('Citations', choice('citations', [
        ['auto', 'Galley picks', 'Each claim takes the source the verifier confirms against its passage.'],
        ['mixed', 'You pick the load-bearing ones', 'Those claims wait for you to choose among sources a, b and c.'],
        ['choose', 'You pick every one', 'Every claim that needs a source waits for your choice.'],
      ])),
      field('Seats', h('table', { class: 'gw-seats' }, h('tbody', {}, seatRow('author', seats?.author), seatRow('checker', seats?.checker), seatRow('challenger', seats?.challenger), seatRow('verifier', seats?.verifier))), 'No family judges its own work; a third family settles what an author and a referee cannot agree on.'),
      field('Literature', h('p', { class: 'gw-facts' }, 'Canary over OpenAlex · ', context ? (context.openalexKey ? h('span', { text: 'key found: two searches per claim' }) : h('span', { class: 'gw-attention', text: 'no key: one search per claim, about 100 searches a day for everyone on this network' })) : 'checking…')),
    ]
  }

  function segmented<T>(options: [string, T][], current: T, pick: (v: T) => void, label: string): HTMLElement {
    return h('div', { class: 'gw-seg', role: 'radiogroup', 'aria-label': label }, ...options.map(([text, value]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(value === current), class: value === current ? 'is-on' : '', text, onclick: () => pick(value) })))
  }

  // An option to include, and once ticked, whether the paper's main contribution rests on it.
  function toggle(key: 'literatureReview' | 'simulation', label: string, help: string, supporting: string, central: string): HTMLElement {
    const role = key === 'literatureReview' ? 'reviewRole' : 'simulationRole'
    const box = h('input', { type: 'checkbox', checked: settings[key] })
    box.addEventListener('change', () => { settings[key] = box.checked; render() })
    const option = h('label', { class: 'gw-choice' }, box, h('span', {}, h('span', { class: 'gw-choice-label', text: label }), h('span', { class: 'gw-help', text: help })))
    if (!settings[key]) return option
    return h('div', { class: 'gw-option' }, option, h('div', { class: 'gw-role' },
      segmented([['Supporting', 'supporting'], ['Main contribution', 'load-bearing']], settings[role], (v) => { settings[role] = v; render() }, `${label}: its part in the paper`),
      h('p', { class: 'gw-help', text: settings[role] === 'load-bearing' ? central : supporting })))
  }

  function choice(key: 'dial' | 'citations', options: [string, string, string][]): HTMLElement {
    return h('div', { class: 'gw-choices', role: 'radiogroup' }, ...options.map(([value, label, help]) => {
      const radio = h('input', { type: 'radio', name: `gw-${key}`, value, checked: settings[key] === value })
      radio.addEventListener('change', () => { settings[key] = value })
      return h('label', { class: 'gw-choice' }, radio, h('span', {}, h('span', { class: 'gw-choice-label', text: label }), h('span', { class: 'gw-help', text: help })))
    }))
  }

  // ---------------------------------------------------------------- 4. start
  function startStep(): (Node | null)[] {
    const s = context?.seats
    const m = (seat: keyof Context['seats']) => s?.[seat]?.model ?? seat
    const datasets = items.filter((i) => i.kind === 'dataset')
    const searches = context?.openalexKey ? 'two' : 'one'
    // A step that runs alongside the others shows its own time but adds little to the whole.
    const plan: [string, string, string, number, boolean?][] = [
      ['Read your seed', 'claims, concern, contribution and host field', m('author'), 1],
      ...(items.length ? [['Read your materials', datasets.length ? 'profile datasets here; read documents and links' : 'read documents and links', 'this machine', 1] as [string, string, string, number]] : []),
      ['Place the idea', '7 literature searches through Canary: closest work, bottleneck, consensus', m('checker'), 3],
      ['Challenge the idea', 'seven impact factors; three directions; one chosen', `${m('challenger')} · ${m('checker')}`, 10],
      ...(settings.literatureReview ? [['Systematic review', `Canary: search plan, screening, at least ${context?.review?.papers ?? 50} full papers read, every finding audited; ${settings.reviewRole === 'load-bearing' ? 'the paper\'s main contribution, so the plan waits for it' : 'alongside the steps below'}`, `${context?.review?.research ?? 'gpt-6.1-sol'} · ${context?.review?.audit ?? 'gpt-6-astra'}`, 40, settings.reviewRole !== 'load-bearing'] as [string, string, string, number, boolean]] : []),
      ...(datasets.length ? [['Measure your data', 'the analyses the claims need, computed on this machine', `${m('author')} · this machine`, 3] as [string, string, string, number]] : []),
      ...(settings.simulation ? [['Simulate', `the author writes the Monte Carlo model and the basis of every input; galley runs it on this machine${settings.simulationRole === 'load-bearing' ? '; the paper\'s main contribution rests on it' : ''}`, `${m('author')} · this machine`, 5] as [string, string, string, number]] : []),
      ['Plan and outline', 'thesis, claims, sections, figures', m('author'), 8],
      ['Find and verify evidence', `${searches} search${searches === 'one' ? '' : 'es'} per claim; verbatim passages; another family's verdict; planted-defect calibration`, `${m('checker')} · ${m('verifier')}`, 20],
      ['Draft', 'every section, checked against its claims', `${m('author')} · ${m('checker')}`, 25],
      ['Review', `${settings.rounds} round${settings.rounds === 1 ? '' : 's'} of four referees; each answer judged by the referee who raised it`, `${m('checker')} · ${m('verifier')}`, 50 * settings.rounds],
      ['Finish', 'ledger reconciled with the text; title and abstract; typeset', `${m('checker')} · ${m('author')}`, 10],
    ]
    const total = plan.reduce((a, p) => a + (p[4] ? 5 : p[3]), 0) + Math.round((settings.words - 7000) / 1000) * 3
    const leaves = [
      [items.some((i) => i.kind !== 'dataset') ? 'Your seed, documents and links' : 'Your seed', 'go to the providers of the three model families (Anthropic, OpenAI, Google).'],
      ...(datasets.some((d) => d.private) ? [['Private datasets', 'never leave this machine; the models see column summaries and computed results.']] : []),
      ...(datasets.some((d) => !d.private) ? [['Shared datasets', 'their summaries and first 15 rows go to the model providers.']] : []),
      ['Search terms', 'go to OpenAlex through Canary.'],
      ...(settings.literatureReview ? [['Review question', 'goes to Canary\'s research and audit models (OpenAI) and to OpenAlex.']] : []),
      ['Your name', 'is never sent; it is set in the byline at typesetting.'],
    ]
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'What happens when you start' }),
      h('ol', { class: 'gw-plan' }, ...plan.map(([what, detail, who, mins]) => h('li', {},
        h('span', { class: 'gw-plan-what' }, h('strong', { text: what }), h('span', { class: 'gw-help', text: detail }), h('span', { class: 'gw-mono gw-plan-who', text: who })),
        h('span', { class: 'gw-mono gw-plan-time', text: minutes(mins) })))),
      h('p', { class: 'gw-facts' }, 'About ', h('strong', { text: minutes(Math.max(60, total)) }), ` for ${n(settings.words)} words. Nothing needs you until the paper is ready${settings.dial === 'autonomous' && settings.citations === 'auto' ? '' : ', except the choices you asked for'}.`),
      h('div', { class: 'gw-box' }, h('div', { class: 'gw-label', text: 'What leaves this machine' }), h('dl', { class: 'gw-leaves' }, ...leaves.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))),
      h('p', { class: 'gw-note', text: `The paper appears in your documents as “${slug}-paper” as soon as it starts. It grows there, every referee finding becomes a thread under its passage, and you can edit and comment while the team works.` }),
    ]
  }

  async function start(): Promise<void> {
    next.disabled = true
    next.textContent = 'Starting…'
    try {
      const materials = await Promise.all(items.map(async (item) => item.kind === 'link'
        ? { name: item.name, url: item.url }
        : { name: item.name, private: item.private, data: await base64(item.file!) }))
      const response = await fetch(`/api/galley-papers/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, settings, materials }),
      })
      if (!response.ok) throw new Error(await response.text())
      const at = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      trail.querySelectorAll('li').forEach((li) => li.classList.add('is-done'))
      body.replaceChildren(
        h('h2', { id: 'gw-title', class: 'gw-title' }, h('span', { class: 'gw-lamp', 'aria-hidden': 'true' }), 'Writing the paper'),
        h('p', { class: 'gw-lead' }, `Started at ${at}. `, h('span', { class: 'gw-mono', text: context?.seats.author.model ?? 'The author' }), ' is reading your seed.'),
        h('p', { class: 'gw-note', text: options.onStart
          ? `The paper is “${slug}-paper” in your documents. Open it to watch it grow: the team writes it there, and you can edit and comment while they work.`
          : `It appears in your documents as “${slug}-paper”. Press the paper button on this document any time to see where it stands.` }),
      )
      back.hidden = true
      next.disabled = false
      next.textContent = options.onStart ? 'Open the paper' : 'Close'
      next.onclick = () => { dialog.close(); options.onStart?.(`${slug}-paper`) }
      hint.textContent = ''
    } catch (error) {
      next.disabled = false
      next.textContent = 'Start the paper'
      body.append(h('p', { class: 'gw-error', role: 'alert', text: `The paper did not start: ${(error as Error).message}` }))
    }
  }
}

interface StatusData {
  slug: string
  title: string | null
  seedTitle: string
  outcome: string | null
  running: boolean
  startedAt: string
  stages: { id: string; label: string; done: boolean }[]
  now: { doing: string; who: string; seconds: number }[]
  waiting: { family: string; name: string; seconds: number; resetsIn: number | null } | null
  claims: { total: number; supported: number; narrowed: number; own: number; premises: number; hypotheses: number; open: number }
  evidence: { screened: number; verified: number; rejected: number }
  sections: { drafted: number; total: number | null }
  review: { round: number; rounds: number; findings: number; open: number }
  cost: { calls: number; tokensInM: number; hours: number }
  typeset: boolean
}

const clock = (iso: string | Date) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const ago = (seconds: number) => seconds < 90 ? `${seconds} s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`

/** Where a paper stands, kept current while the window is open. */
export function openPaperStatus(slug: string, open?: (manuscript: string) => void): void {
  const body = h('div', { class: 'gw-body' })
  const updated = h('span', { class: 'gw-hint' })
  const openButton = h('button', { type: 'button', class: 'gw-btn', text: 'Open the manuscript', hidden: true })
  const close = h('button', { type: 'button', class: 'gw-btn gw-btn--primary', text: 'Close', onclick: () => dialog.close() })
  const dialog = h('dialog', { class: 'gw gw--status', 'aria-labelledby': 'gw-title' }, body, h('footer', { class: 'gw-foot' }, updated, h('div', { class: 'gw-actions' }, openButton, close)))
  let timer = 0
  dialog.addEventListener('close', () => { window.clearInterval(timer); dialog.remove() })
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close() })
  document.body.append(dialog)
  dialog.showModal()
  close.focus()

  const draw = (d: StatusData) => {
    const current = d.stages.findIndex((s) => !s.done)
    const done = d.outcome === 'ready_for_submission'
    const state = done
      ? h('p', { class: 'gw-state is-done' }, h('span', { class: 'gw-state-mark', 'aria-hidden': 'true', text: '✓' }), 'Ready for submission')
      : d.running
        ? h('p', { class: 'gw-state' }, h('span', { class: 'gw-lamp', 'aria-hidden': 'true' }), `Running · ${d.stages[current]?.label ?? 'Finishing'}`)
        : h('p', { class: 'gw-state is-stopped' }, h('span', { class: 'gw-state-mark', 'aria-hidden': 'true', text: '‖' }), d.outcome ? `Ended: ${d.outcome.replace(/_/g, ' ')}` : 'Not running')
    const n = (x: number | null) => x === null ? '…' : x.toLocaleString('en-US')
    const rows: [string, string][] = [
      ['Claims', `${n(d.claims.total)}: ${d.claims.supported + d.claims.narrowed} with verified sources, ${d.claims.own} your work, ${d.claims.premises} premises, ${d.claims.hypotheses} hypotheses, ${d.claims.open} still open`],
      ['Evidence', `${n(d.evidence.screened)} works screened · ${d.evidence.verified} citations verified · ${d.evidence.rejected} rejected`],
      ['Sections', d.sections.total === null ? 'not outlined yet' : `${d.sections.drafted} of ${d.sections.total} drafted`],
      ['Review', d.review.round ? `round ${d.review.round} of ${d.review.rounds} · ${d.review.findings} findings, ${d.review.open} open` : `${d.review.rounds} round${d.review.rounds === 1 ? '' : 's'}, after the draft`],
      ['So far', `${n(d.cost.calls)} model calls · ${d.cost.tokensInM} M tokens · ${d.cost.hours} h`],
    ]
    body.replaceChildren(...[
      h('div', { class: 'gw-label', text: 'Paper' }),
      h('h2', { id: 'gw-title', class: 'gw-title', text: d.title ?? d.seedTitle ?? 'Untitled paper' }),
      state,
      h('p', { class: 'gw-note', text: `Started ${clock(d.startedAt)}${d.title ? ` · from “${d.seedTitle.length > 70 ? `${d.seedTitle.slice(0, 70)}…` : d.seedTitle}”` : ''}` }),
      h('ol', { class: d.stages.length > 7 ? 'gw-stages gw-stages--dense' : 'gw-stages' }, ...d.stages.map((s, i) => h('li', { class: s.done ? 'is-done' : i === current && !done ? 'is-current' : '' },
        h('span', { class: 'gw-num', text: s.done ? '✓' : String(i + 1) }), h('span', { class: 'gw-stage', text: s.label })))),
      d.running && d.now.length
        ? h('div', { class: 'gw-box' }, h('div', { class: 'gw-label', text: 'Now' }), ...d.now.map((f) => h('p', { class: 'gw-now' }, h('span', { class: 'gw-now-what' }, h('strong', { text: f.doing }), h('span', { class: 'gw-mono gw-now-who', text: f.who })), h('span', { class: 'gw-mono gw-now-time', text: ago(f.seconds) }))))
        : d.running && d.waiting ? h('div', { class: 'gw-box' }, h('div', { class: 'gw-label', text: 'Now' }), h('p', { class: 'gw-now' }, h('span', { class: 'gw-now-what' }, h('strong', { text: `Waiting for ${d.waiting.name}` }), h('span', { class: 'gw-now-who', text: d.waiting.resetsIn === null ? 'Usage limit; it carries on by itself.' : d.waiting.resetsIn > 0 ? `Usage quota; resets in ${ago(d.waiting.resetsIn)}.` : 'Usage quota has reset.' })), h('span', { class: 'gw-mono gw-now-time', text: `next try in ${ago(d.waiting.seconds)}` })))
        : d.running ? h('div', { class: 'gw-box' }, h('div', { class: 'gw-label', text: 'Now' }), h('p', { class: 'gw-now' }, h('span', { class: 'gw-help', text: 'Between steps; the next one starts in a moment.' }))) : null,
      h('dl', { class: 'gw-figures' }, ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
    ].filter((x) => !!x) as HTMLElement[])
    openButton.hidden = !(d.typeset && open)
    openButton.onclick = () => { dialog.close(); open?.(d.slug) }
    updated.textContent = done || !d.running ? `As of ${clock(new Date())}` : `Updated ${clock(new Date())} · refreshes every 10 s`
    if (done || !d.running) window.clearInterval(timer)
  }

  const load = async () => {
    try {
      const response = await fetch(`/api/galley-papers/${encodeURIComponent(slug)}`)
      if (!response.ok) throw new Error(await response.text())
      draw((await response.json()).data as StatusData)
    } catch (error) {
      body.replaceChildren(h('h2', { id: 'gw-title', class: 'gw-title', text: 'Paper status' }), h('p', { class: 'gw-error', role: 'alert', text: `The status could not be read: ${(error as Error).message}` }))
    }
  }
  body.append(h('h2', { id: 'gw-title', class: 'gw-title', text: 'Paper status' }), h('p', { class: 'gw-note', text: 'Reading where the paper stands…' }))
  void load()
  timer = window.setInterval(load, 10_000)
}

export type { EditorAction }
