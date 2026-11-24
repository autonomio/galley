// From a seed document to a thesis or a paper. The first step decides which. A paper then
// goes through the seed, the materials it draws on, the settings that change the outcome,
// and an exact account of what happens and what leaves this machine. A thesis first takes
// its direction (extend, contest or reframe), then the seed, its few settings and the same
// account. Nothing starts until Start.
import type { EditorAction } from '../src/index.js'
import { SOFTWARE_ROLE_HINT, SOFTWARE_SUBJECT_HINT, softwareSubject, softwareSubjectFromSeed, type SoftwareRole } from '../src/core/software-subject.js'

interface Seat { family: string; name: string; model: string }
type ModelPlan = Pick<Context, 'providers' | 'seats' | 'refereeModels' | 'adjudicator'>
interface Context {
  modelRevision: string
  choices?: Record<string, ModelPlan>
  providers: string[]
  refereeModels: string[]
  adjudicator: string
  openalexKey: boolean
  /** The model families galley can use, with the model behind each. */
  families?: Seat[]
  seats: Record<'author' | 'checker' | 'challenger' | 'verifier', Seat>
  referees: string[]
  defaults: { venue: string; words: number; rounds: number; dial: string; citations: string; literatureReview?: boolean; simulation?: boolean }
  review?: { research: string; audit: string; papers: number }
}
/** The seed as the person wrote it, kept for reference and folded away. */
function seedReference(text: string): HTMLElement {
  return h('details', { class: 'gw-seed' }, h('summary', { text: 'Your seed, as you wrote it' }), h('blockquote', { class: 'gw-quote', text: text || '(empty)' }))
}

interface Item { name: string; kind: 'dataset' | 'document' | 'link'; url?: string; file?: File; detail: string; private: boolean }
/** A dataset as its producers know it: one or more files under one name, with where the data comes from. */
interface DatasetItem {
  name: string; files: { file: File; detail: string }[]; producedBy: 'authors' | 'others'; doi: string; version: string; describedIn: string; licence: string; private: boolean
  /** A dataset given by its link: the published record it comes from, what the record says, and its files as listed there. */
  record?: string; creators?: string; remote?: { name: string; size: number }[]; recordState?: 'reading' | 'read' | 'failed'
  /** A database: its connection (a saved name, or the line and where ClickHouse was found) and which database, with its size. */
  db?: { connection?: string; line?: string; via?: string; host?: string; container?: string; url?: string; user?: string; database: string; summary: string }
}
/** A ClickHouse found from one connection line, with its databases. */
interface FoundDatabase { via: string; label: string; url?: string; user?: string; host?: string; container?: string; version: string; databases: { name: string; tables: number; rows: number; bytes: number }[] }
const size = (bytes: number) => bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GiB` : `${Math.max(1, Math.round(bytes / 2 ** 20))} MiB`
const rowsText = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} billion rows` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} million rows` : `${n.toLocaleString('en-US')} rows`
const FAMILY_ORDER = ['claude', 'gpt', 'gemini']
const SOFTWARE_ROLES: [SoftwareRole, string, string][] = [
  ['instrument', 'Use as an instrument', 'Run it for a research task and use its outputs as evidence in the paper.'],
  ['introduction', 'Introduce our software', 'Make the authors’ software and what it enables the contribution.'],
]
type SeatName = 'author' | 'checker' | 'challenger' | 'verifier'

/** The seats for the families that are on, as the engine deals them: the author keeps its family if on, else the first on writes; checking seats never go to the author's family. */
function dealSeats(context: Context | null, on: string[]): Record<SeatName, Seat | undefined> {
  const base = context?.seats
  const families = on.length ? FAMILY_ORDER.filter((f) => on.includes(f)) : FAMILY_ORDER
  const info = (family: string) => context?.families?.find((f) => f.family === family) ?? Object.values(base ?? {}).find((s) => s.family === family)
  const author = base && families.includes(base.author.family) ? base.author.family : families[0]
  const away = (f?: string) => f && f !== author && families.includes(f) ? f : families.find((x) => x !== author)!
  return { author: info(author), checker: info(away(base?.checker.family)), challenger: info(away(base?.challenger.family)), verifier: info(away(base?.verifier.family)) }
}

/** A link to a published dataset galley can read: a Zenodo record or its DOI. */
const DATASET_RECORD = /zenodo\.org\/(api\/)?(records?|deposit|uploads)\/\d+|10\.5281\/zenodo\.\d+/i

const PAPER_STEPS = ['Make', 'Seed', 'Materials', 'Settings', 'Start'] as const
const THESIS_STEPS = ['Make', 'Direction', 'Seed', 'Settings', 'Start'] as const
type Step = typeof PAPER_STEPS[number] | typeof THESIS_STEPS[number]

/** A thesis's direction toward what the field holds. */
const STANCES: [string, string, string, string][] = [
  ['extend', 'Extend', 'With the flow', 'Builds on what the field holds: the next step its strongest position supports but has not yet taken.'],
  ['contest', 'Contest', 'Against the flow', 'Goes against what the field holds: names the assumption it rests on that is wrong, and what would decide between the two.'],
  ['reframe', 'Reframe', 'Beyond the flow', 'Leaves the field\'s positions for another axis: a framing or a question the field cannot ask today, checked against the literature to be new rather than merely contrarian.'],
]
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

/** Opens the wizard; the dialog is returned so a host can tell when it closes. */
export function openPaperWizard(options: { slug: string; title: string; text: string; onStart?: (paper: string) => void }): HTMLDialogElement {
  const { slug, title, text } = options
  const words = text.split(/\s+/).filter(Boolean).length
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length
  const items: Item[] = []
  const datasets: DatasetItem[] = []
  // Connecting a database: what one line found, and the connections saved on the machine running galley.
  let found: FoundDatabase[] | null = null
  let finding: 'idle' | 'finding' | 'failed' = 'idle'
  let findError = ''
  let foundLine = ''
  let allDatabases = false
  let saved: { name: string; via: string; host?: string; url?: string; container?: string; database: string }[] | null = null
  // Set while the start request is out, so neither Back and Next nor a second press can send it twice.
  let starting = false
  // Set once it has started: the dialog then shows the run, and nothing redraws the steps over it.
  let started = false
  // A world model the paper's sources come from: a Resolvent repository as a zip, read once on the machine running galley.
  let worldModel: { file: string; state: 'reading' | 'read' | 'failed'; error?: string; token?: string; name?: string; claims?: number; evidence?: number; sources?: number; only: boolean } | null = null
  const seedCommit = softwareSubjectFromSeed(text)
  let softwareLink = ''
  let softwareRole: SoftwareRole | undefined
  let reviewChosen = false
  let step = 0
  let context: Context | null = null
  const settings = { mode: '' as '' | 'paper' | 'thesis', stance: '' as '' | 'extend' | 'contest' | 'reframe', author: '', affiliation: '', funding: '', competingInterests: '', acknowledgements: '', venue: 'preprint (arXiv)', words: 7000, rounds: 2, dial: 'autonomous', citations: 'auto', literatureReview: false, reviewRole: 'supporting', simulation: false, simulationRole: 'supporting', webSources: true, families: [...FAMILY_ORDER] }

  const dialog = h('dialog', { class: 'gw', 'aria-labelledby': 'gw-title' })
  const trail = h('ol', { class: 'gw-trail' })
  const body = h('div', { class: 'gw-body' })
  const back = h('button', { type: 'button', class: 'gw-btn', text: 'Back', onclick: () => go(step - 1) })
  const next = h('button', { type: 'button', class: 'gw-btn gw-btn--primary', onclick: () => step < steps().length - 1 ? go(step + 1) : start() })
  const steps = (): readonly Step[] => settings.mode === 'thesis' ? THESIS_STEPS : PAPER_STEPS
  const thesis = () => settings.mode === 'thesis'
  const hint = h('span', { class: 'gw-hint', text: 'Esc closes. Nothing starts until you press Start.' })
  dialog.append(h('header', { class: 'gw-head' }, trail), body, h('footer', { class: 'gw-foot' }, hint, h('div', { class: 'gw-actions' }, back, next)))
  dialog.addEventListener('close', () => dialog.remove())
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close() })
  document.body.append(dialog)
  dialog.showModal()

  async function readContext(): Promise<Context> {
    const response = await fetch('/api/galley-papers/_context', { cache: 'no-store' })
    if (!response.ok) throw new Error('Model settings could not be loaded.')
    return response.json()
  }
  render()
  void readContext().then((c) => {
    context = c
    settings.families = c.families?.map((f) => f.family) ?? [...FAMILY_ORDER]
    if (steps()[step] !== 'Settings' && steps()[step] !== 'Start') Object.assign(settings, { venue: c.defaults.venue, words: c.defaults.words, rounds: c.defaults.rounds, dial: c.defaults.dial, citations: c.defaults.citations, simulation: !!c.defaults.simulation })
    if (!reviewChosen) settings.literatureReview = softwareRole === 'introduction' || !!c.defaults.literatureReview
    if (steps()[step] === 'Settings' || steps()[step] === 'Start') render()
  }).catch((error: Error) => { hint.textContent = error.message })

  function go(to: number): void {
    if (to > step && steps()[step] === 'Materials') {
      const link = body.querySelector<HTMLInputElement>('#gw-software')!
      if (softwareLink.trim() && !softwareSubject(softwareLink)) {
        link.setCustomValidity(SOFTWARE_SUBJECT_HINT)
        link.reportValidity()
        return
      }
      if (softwareLink.trim() && !softwareRole) {
        body.querySelector<HTMLElement>('#gw-software-role-error')!.hidden = false
        body.querySelector<HTMLInputElement>('[name="gw-software-role"]')?.focus()
        return
      }
      if (!reviewChosen) settings.literatureReview = softwareRole === 'introduction' || !!context?.defaults.literatureReview
    }
    step = Math.max(0, Math.min(steps().length - 1, to))
    render()
  }

  function render(): void {
    // Settings that arrive after the start, or anything else, leave the started run's screen and its button alone.
    if (started) return
    const all = steps()
    trail.replaceChildren(...all.map((name, i) => h('li', { class: i === step ? 'is-current' : i < step ? 'is-done' : '', 'aria-current': i === step ? 'step' : undefined },
      h('span', { class: 'gw-num', text: String(i + 1) }), name)))
    back.hidden = step === 0
    next.textContent = step === all.length - 1 ? (thesis() ? 'Start the thesis' : 'Start the paper') : `Next: ${all[step + 1]}`
    // The first step asks what to make, and a thesis its direction: neither has a default. A start under way is never
    // started twice.
    next.disabled = starting || (all[step] === 'Start' && !context) || (all[step] === 'Make' && !settings.mode) || (all[step] === 'Direction' && !settings.stance)
    back.disabled = starting
    const draw: Record<Step, () => (Node | null)[]> = { Make: makeStep, Direction: directionStep, Seed: seedStep, Materials: materialsStep, Settings: settingsStep, Start: startStep }
    body.replaceChildren(...draw[all[step]]().filter((x): x is Node => !!x))
    body.scrollTop = 0
    const first = body.querySelector<HTMLElement>('input, button, select, textarea')
    ;(steps()[step] === 'Seed' ? next : first ?? next).focus()
  }

  // ---------------------------------------------------------------- what to make
  /** A choice among options, as radio buttons; picking one redraws, since it changes the steps that follow. */
  function pick(name: string, label: string, current: string, options: [string, string, string][], set: (value: string) => void): HTMLElement {
    return h('div', { class: 'gw-choices', role: 'radiogroup', 'aria-label': label }, ...options.map(([value, text, help]) => {
      const radio = h('input', { type: 'radio', name, value, checked: current === value })
      radio.addEventListener('change', () => { set(value); render() })
      return h('label', { class: 'gw-choice' }, radio, h('span', {}, h('span', { class: 'gw-choice-label', text }), h('span', { class: 'gw-help', text: help })))
    }))
  }

  function makeStep(): (Node | null)[] {
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'What to make' }),
      h('p', { class: 'gw-lead', text: `From your words in “${title}”.` }),
      pick('gw-mode', 'What to make', settings.mode, [
        ['thesis', 'A thesis', 'One proposition worth exploring, formulated against what the literature holds and tested for its direction. About an hour. It comes back as a brief in this document, to explore further and later turn into a paper.'],
        ['paper', 'A paper', 'A full manuscript, researched, drafted, refereed and typeset, ready for submission. Several hours.'],
      ], (value) => { settings.mode = value as 'paper' | 'thesis' }),
    ]
  }

  function directionStep(): (Node | null)[] {
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'The thesis\'s direction' }),
      h('p', { class: 'gw-lead', text: 'How the thesis stands to what the field already holds. It decides what the literature review looks for and the test the thesis has to meet.' }),
      pick('gw-stance', 'Direction', settings.stance, STANCES.map(([value, name, flow, help]) => [value, `${name}: ${flow.toLowerCase()}`, help] as [string, string, string]), (value) => { settings.stance = value as 'extend' | 'contest' | 'reframe' }),
    ]
  }

  // ---------------------------------------------------------------- seed
  function seedStep(): (Node | null)[] {
    if (thesis()) return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'Your seed' }),
      h('p', { class: 'gw-lead', text: `The thesis starts from your words in “${title}”. galley places the idea in the literature, has Canary review what the field holds, and formulates the thesis from both.` }),
      h('p', { class: 'gw-facts' }, h('span', { class: 'gw-mono', text: n(words) }), ' words · ', h('span', { class: 'gw-mono', text: n(paragraphs) }), ` paragraph${paragraphs === 1 ? '' : 's'}`),
      seedReference(text),
      h('p', { class: 'gw-note', text: 'When the brief is ready it is written into this document; your words stay in the project\'s settings for reference.' }),
    ]
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'Your seed' }),
      h('p', { class: 'gw-lead', text: `The paper starts from your words in “${title}”. Nothing is added to them: galley challenges the idea, researches it and writes from them.` }),
      h('p', { class: 'gw-facts' }, h('span', { class: 'gw-mono', text: n(words) }), ' words · ', h('span', { class: 'gw-mono', text: n(paragraphs) }), ` paragraph${paragraphs === 1 ? '' : 's'}`),
      seedReference(text),
      h('p', { class: 'gw-note', text: 'When the paper starts, these words move into its settings, where they stay for reference, and this document becomes the paper: it is written here and grows as the team works.' }),
    ]
  }

  // ---------------------------------------------------------------- 2. materials
  function materialsStep(): (Node | null)[] {
    const picker = h('input', { type: 'file', multiple: true, class: 'gw-file', 'aria-label': 'Choose files', accept: '.csv,.tsv,.json,.xlsx,.md,.txt,.tex,.docx,.odt,.html,.pdf' })
    picker.addEventListener('change', () => add([...(picker.files ?? [])]))
    const folder = h('input', { type: 'file', multiple: true, class: 'gw-file', 'aria-label': 'Choose a folder', webkitdirectory: true })
    folder.addEventListener('change', () => add([...(folder.files ?? [])]))
    const drop = h('label', { class: 'gw-drop' },
      picker,
      h('span', { class: 'gw-drop-main', text: 'Drop files here, or choose files' }),
      h('span', { class: 'gw-drop-sub', text: 'Data files added together form one dataset (CSV, TSV, JSON, Excel), with any README among them · Documents: Markdown, text, Word, PDF' }))
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over') })
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'))
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); add([...(e.dataTransfer?.files ?? [])]) })
    const url = h('input', { type: 'url', class: 'gw-input', placeholder: 'https://', 'aria-label': 'Link' })
    const addLink = () => {
      const value = url.value.trim()
      if (!/^https?:\/\/\S+\.\S+/i.test(value)) { url.setCustomValidity('A full address, starting with http:// or https://'); url.reportValidity(); return }
      url.setCustomValidity('')
      // A link to a published dataset is a dataset: galley reads its record for how to cite it and downloads its files.
      if (DATASET_RECORD.test(value)) { void addRecord(value); return }
      items.push({ name: value, kind: 'link', url: value, detail: 'Read once, when the paper starts', private: false })
      render()
    }
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLink() } })
    const software = h('input', {
      id: 'gw-software', type: 'url', class: 'gw-input', value: softwareLink,
      placeholder: 'https://github.com/owner/repo/commit/…', 'aria-describedby': 'gw-software-help',
    })
    const roleError = h('div', { id: 'gw-software-role-error', hidden: true }, h('p', { class: 'gw-error', role: 'alert', text: SOFTWARE_ROLE_HINT }))
    const roleChoices = h('div', { hidden: !softwareLink.trim(), role: 'radiogroup', 'aria-label': 'Role in the paper', 'aria-describedby': 'gw-software-help' },
      h('div', { class: 'gw-choices' }, ...SOFTWARE_ROLES.map(([role, label, help]) => {
        const input = h('input', { type: 'radio', name: 'gw-software-role', value: role, checked: softwareRole === role })
        input.addEventListener('change', () => { softwareRole = role; roleError.hidden = true })
        return h('label', { class: 'gw-choice' }, input, h('span', {}, h('span', { class: 'gw-choice-label', text: label }), h('span', { class: 'gw-help', text: help })))
      })), roleError)
    const useSeed = seedCommit ? h('button', { type: 'button', class: 'gw-btn', text: 'Use commit from seed', onclick: () => {
      software.value = seedCommit.url
      updateSoftwareLink()
      roleChoices.querySelector('input')?.focus()
    } }) : null
    function updateSoftwareLink(): void {
      softwareLink = software.value
      software.setCustomValidity('')
      roleChoices.hidden = !softwareLink.trim()
      if (roleChoices.hidden) {
        softwareRole = undefined
        roleError.hidden = true
        for (const radio of roleChoices.querySelectorAll('input')) radio.checked = false
      }
    }
    software.addEventListener('input', updateSoftwareLink)
    const list = items.length
      ? h('ul', { class: 'gw-list' }, ...items.map((item, i) => h('li', { class: 'gw-row' },
        h('span', { class: `gw-kind gw-kind--${item.kind}`, 'aria-hidden': 'true' }),
        h('span', { class: 'gw-row-main' }, h('span', { class: 'gw-mono gw-row-name', text: item.name }), h('span', { class: 'gw-row-detail', text: item.detail })),
        item.kind === 'dataset' ? segmented([['Private', true], ['Shared', false]], item.private, (v) => { item.private = v; render() }, `Who may read ${item.name}`) : h('span', { class: 'gw-row-kind', text: item.kind }),
        h('button', { type: 'button', class: 'gw-x', 'aria-label': `Remove ${item.name}`, text: '×', onclick: () => { items.splice(i, 1); render() } }))))
      : datasets.length || worldModel ? null : h('p', { class: 'gw-empty', text: 'No materials. The paper will rest on your seed and the literature.' })
    const privateSets = datasets.filter((d) => d.private).length
    const sharedSets = datasets.filter((d) => !d.private).length
    const read = items.length
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'What the paper draws on' }),
      h('p', { class: 'gw-lead', text: 'Besides the literature, a paper can rest on your own material: data, notes, drafts, pages.' }),
      drop,
      h('div', { class: 'gw-linkrow' }, url, h('button', { type: 'button', class: 'gw-btn', text: 'Add link', onclick: addLink }), h('label', { class: 'gw-btn gw-folder' }, folder, 'Choose a folder')),
      databaseRow(),
      worldModelRow(),
      ...datasets.map(datasetCard),
      list,
      h('div', { class: 'gw-field' }, h('label', { class: 'gw-label', for: 'gw-software', text: 'Software' }),
        h('div', { class: 'gw-linkrow' }, software, useSeed),
        h('p', { id: 'gw-software-help', class: 'gw-help', text: 'Enter an exact GitHub commit link and choose the software’s role in the paper.' }), roleChoices),
      privateSets ? h('p', { class: 'gw-note' }, h('strong', { text: 'Private datasets stay on this machine. ' }), 'The models see only a summary of each column and the results galley computes here, and every number the paper states about your data comes from those results.') : null,
      sharedSets ? h('p', { class: 'gw-note', text: 'Shared datasets: the models also read their first 15 rows.' }) : null,
      read ? h('p', { class: 'gw-note', text: 'Documents and links are read by the models that write and review the paper.' }) : null,
    ]
  }

  /** One dataset: its name, its files, and where the data comes from, which decides how the paper may describe it. */
  function datasetCard(d: DatasetItem, index: number): HTMLElement {
    const text = (key: 'name' | 'doi' | 'version' | 'describedIn' | 'licence', label: string, placeholder = label) => {
      const el = h('input', { class: 'gw-input', value: d[key], placeholder, 'aria-label': `${label}, ${d.name}` })
      el.addEventListener('input', () => { d[key] = el.value })
      return el
    }
    const more = h('input', { type: 'file', multiple: true, class: 'gw-file', 'aria-label': `Add files to ${d.name}` })
    more.addEventListener('change', async () => { await addTo(d, [...(more.files ?? [])]); render() })
    const row = (label: string, control: Node) => h('div', { class: 'gw-dataset-row' }, h('span', { class: 'gw-label', text: label }), control)
    return h('section', { class: 'gw-dataset', 'aria-label': `Dataset ${d.name}` },
      h('div', { class: 'gw-dataset-head' },
        h('span', { class: 'gw-kind gw-kind--dataset', 'aria-hidden': 'true' }), text('name', 'Dataset name'),
        segmented([['Private', true], ['Shared', false]], d.private, (v) => { d.private = v; render() }, `Who may read ${d.name}`),
        h('button', { type: 'button', class: 'gw-x', 'aria-label': `Remove ${d.name}`, text: '×', onclick: () => { datasets.splice(index, 1); render() } })),
      ...(d.db ? [
        h('p', { class: 'gw-help', text: `Database ${d.db.database}: ${d.db.summary}. Read-only: the analyses take only the extracts they need from it, as queries aggregated in the database, and every query goes into the evidence package.` }),
      ] : d.record ? [
        h('p', { class: 'gw-help', text: d.recordState === 'reading' ? `Reading ${d.record} …`
          : d.recordState === 'failed' ? `The record at ${d.record} could not be read. Check the link; galley tries again when the paper starts.`
            : `Published by ${d.creators || 'its creators'}${d.version ? `, version ${d.version}` : ''}${d.licence ? `, ${d.licence}` : ''}${d.doi ? `, DOI ${d.doi}` : ''}. The paper cites it by this record.` }),
        d.remote?.length ? h('ul', { class: 'gw-list' }, ...d.remote.map((f) => h('li', { class: 'gw-row gw-row--file' },
          h('span', { class: 'gw-row-main' }, h('span', { class: 'gw-mono gw-row-name', text: f.name }), h('span', { class: 'gw-row-detail', text: `${Math.max(1, Math.round(f.size / 1024)).toLocaleString('en-US')} kB · downloaded${/\.zip$/i.test(f.name) ? ' and unpacked' : ''} when the paper starts` }))))) : null,
      ] : [
        h('ul', { class: 'gw-list' }, ...d.files.map((f, i) => h('li', { class: 'gw-row gw-row--file' },
          h('span', { class: 'gw-row-main' }, h('span', { class: 'gw-mono gw-row-name', text: f.file.name }), h('span', { class: 'gw-row-detail', text: f.detail })),
          h('button', { type: 'button', class: 'gw-x', 'aria-label': `Remove ${f.file.name}`, text: '×', onclick: () => { d.files.splice(i, 1); if (!d.files.length) datasets.splice(index, 1); render() } })))),
        h('label', { class: 'gw-btn gw-addfiles' }, more, 'Add files to this dataset'),
      ]),
      row(d.db ? 'Who keeps it' : 'Who produced it', segmented([['I or my group', 'authors'], ['Others', 'others']], d.producedBy, (v) => { d.producedBy = v as DatasetItem['producedBy']; render() }, `Who produced ${d.name}`)),
      ...(d.db ? [] : [
        row('Published as', text('doi', 'Published as', 'DOI or link, if published')),
        row('Version', text('version', 'Version', 'Version, if any')),
        row('First reported in', text('describedIn', 'First reported in', 'DOI or link of the paper that first reported it')),
        row('Licence', text('licence', 'Licence', 'Licence, if any')),
      ]),
      h('p', { class: 'gw-help', text: d.producedBy === 'others' || d.doi || d.describedIn
        ? 'The paper analyses this data and cites it where it describes it, never as measurements made for this paper.'
        : 'Data you produced for this paper is your own work. If it was published before, give where, and the paper cites it.' }))
  }

  /**
   * Connect a database with one line: user@server (reached over SSH with your keys) or a clickhouse:// address. galley
   * finds the ClickHouse there and lists its databases; pick one and it becomes a dataset. A connection used before can
   * be picked by its name.
   */
  function databaseRow(): HTMLElement {
    if (saved === null) {
      saved = []
      void fetch('/api/galley-papers/_databases').then((r) => r.ok ? r.json() : []).then((list) => { saved = list; if (saved?.length) render() }).catch(() => {})
    }
    const line = h('input', { type: 'text', class: 'gw-input', value: foundLine, placeholder: 'user@server, or clickhouse://user:password@host:8123', 'aria-label': 'Database connection' })
    const find = async () => {
      foundLine = line.value.trim()
      if (!foundLine) return
      finding = 'finding'
      found = null
      allDatabases = false
      render()
      try {
        // The line may carry a password: it goes in the body, never in a URL.
        const response = await fetch('/api/galley-papers/_databases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: foundLine }) })
        if (!response.ok) throw new Error(await response.text())
        found = await response.json()
        finding = 'idle'
      } catch (error) {
        finding = 'failed'
        findError = (error as Error).message
      }
      render()
    }
    line.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void find() } })
    const use = (db: DatasetItem['db'], name: string) => {
      datasets.push({ name, files: [], producedBy: 'authors', doi: '', version: '', describedIn: '', licence: '', private: true, db })
      found = null
      render()
    }
    // A server can hold many databases, most of them empty or small: the ten largest that hold data first, the rest on request.
    const offered = (found ?? []).flatMap((f) => f.databases.map((d) => ({ f, d }))).sort((a, b) => b.d.bytes - a.d.bytes)
    const first = offered.filter(({ d }) => d.rows > 0).slice(0, 10)
    const shown = allDatabases ? offered : first
    const options = shown.map(({ f, d }) => h('li', { class: 'gw-row gw-row--file' },
      h('span', { class: 'gw-row-main' }, h('span', { class: 'gw-mono gw-row-name', text: d.name }), h('span', { class: 'gw-row-detail', text: `${d.tables} tables · ${rowsText(d.rows)} · ${size(d.bytes)} · ClickHouse ${f.version}, ${f.label}` })),
      h('button', { type: 'button', class: 'gw-btn', text: 'Use', 'aria-label': `Use ${d.name}`, onclick: () => use({ line: foundLine, via: f.via, host: f.host, container: f.container, url: f.url, user: f.user, database: d.name, summary: `${d.tables} tables · ${rowsText(d.rows)} · ${size(d.bytes)} · ClickHouse ${f.version} · ${f.label}` }, d.name) })))
    return h('div', { class: 'gw-field' },
      h('div', { class: 'gw-label', text: 'Connect a database' }),
      h('div', { class: 'gw-linkrow' }, line, h('button', { type: 'button', class: 'gw-btn', text: finding === 'finding' ? 'Connecting …' : 'Connect', onclick: () => void find(), ...(finding === 'finding' ? { disabled: true } : {}) })),
      saved?.length ? h('div', { class: 'gw-stack' }, ...saved.map((c) => h('button', { type: 'button', class: 'gw-btn gw-saved', text: `Use ${c.name}`, onclick: () => use({ connection: c.name, database: c.database, summary: `saved connection: ${c.name}` }, c.database) }))) : null,
      finding === 'failed' ? h('p', { class: 'gw-attention', text: `Not connected: ${findError}` }) : null,
      found && !offered.length ? h('p', { class: 'gw-help', text: 'No ClickHouse that galley can query was found there.' }) : null,
      options.length ? h('ul', { class: 'gw-list' }, ...options) : null,
      offered.length > shown.length ? h('button', { type: 'button', class: 'gw-btn gw-saved', text: `Show all ${offered.length} databases`, onclick: () => { allDatabases = true; render() } }) : null,
      h('p', { class: 'gw-help', text: 'Read-only: galley takes from it only the extracts the analyses need, as queries aggregated in the database. A server is reached over SSH with the keys of the machine that runs galley, which keeps the connection under a name for everyone who uses it; a password never reaches a paper or a model.' }))
  }

  /**
   * A world model as the paper's sources: a Resolvent repository as a zip. It is read once on the machine running
   * galley, and the card says what it holds. By default the paper's sources are only its sources.
   */
  function worldModelRow(): HTMLElement {
    if (!worldModel) {
      const picker = h('input', { type: 'file', class: 'gw-file', accept: '.zip,application/zip', 'aria-label': 'Choose a world model' })
      picker.addEventListener('change', () => { const file = picker.files?.[0]; if (file) void readWorldModel(file) })
      return h('div', { class: 'gw-field' },
        h('div', { class: 'gw-label', text: 'A world model as the sources' }),
        h('label', { class: 'gw-btn gw-addfiles' }, picker, 'Choose a world model (zip)'),
        h('p', { class: 'gw-help', text: 'A Resolvent world model, its repository as a zip: claims, the evidence they rest on, and the sources behind it, each with its verbatim passage. The paper\'s sources then come from it.' }))
    }
    const wm = worldModel
    return h('section', { class: 'gw-dataset', 'aria-label': 'World model' },
      h('div', { class: 'gw-dataset-head' },
        h('span', { class: 'gw-kind gw-kind--dataset', 'aria-hidden': 'true' }),
        h('span', { class: 'gw-mono gw-row-name', text: wm.name ?? wm.file }),
        h('button', { type: 'button', class: 'gw-x', 'aria-label': 'Remove the world model', text: '×', onclick: () => { worldModel = null; render() } })),
      h('p', { class: wm.state === 'failed' ? 'gw-attention' : 'gw-help', text: wm.state === 'reading' ? `Reading ${wm.file} …`
        : wm.state === 'failed' ? `Not read: ${wm.error}`
          : `World model: ${n(wm.claims ?? 0)} claims, ${n(wm.evidence ?? 0)} evidence records, ${n(wm.sources ?? 0)} sources with their passages.` }),
      h('div', { class: 'gw-dataset-row' }, h('span', { class: 'gw-label', text: 'Sources' }),
        segmented([['Only this world model', true], ['Also the literature and the web', false]], wm.only, (v) => { wm.only = v; render() }, 'Where the sources come from')),
      h('p', { class: 'gw-help', text: wm.only
        ? 'Every source the paper cites comes from this world model: no literature search, no systematic review, no web sources. What it does not support, the paper states as its own argument or as open.'
        : 'The world model is searched first, then the literature through Canary and, where neither has a source, the web.' }))
  }

  async function readWorldModel(file: File): Promise<void> {
    worldModel = { file: file.name, state: 'reading', only: true }
    render()
    try {
      const response = await fetch(`/api/galley-papers/_world-model?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file })
      if (!response.ok) throw new Error(await response.text())
      const read = await response.json() as { token: string; name: string; claims: number; evidence: number; sources: number }
      if (worldModel?.file === file.name) worldModel = { ...worldModel, ...read, state: 'read' }
    } catch (error) {
      if (worldModel?.file === file.name) worldModel = { ...worldModel, state: 'failed', error: (error as Error).message }
    }
    render()
  }

  /** A dataset by its link: the card shows what the record says at once; the files are downloaded when the paper starts. */
  async function addRecord(link: string): Promise<void> {
    const d: DatasetItem = { name: link, files: [], producedBy: 'others', doi: '', version: '', describedIn: '', licence: '', private: false, record: link, recordState: 'reading' }
    datasets.push(d)
    render()
    try {
      const response = await fetch(`/api/galley-papers/_record?link=${encodeURIComponent(link)}`)
      if (!response.ok) throw new Error(await response.text())
      const r = await response.json() as { name: string; creators: string[]; version?: string; doi?: string; licence?: string; describedIn?: string; files: { name: string; size: number }[] }
      Object.assign(d, { name: r.name, creators: r.creators.join(', '), version: r.version ?? '', doi: r.doi ?? '', licence: r.licence ?? '', describedIn: r.describedIn ?? '', remote: r.files, recordState: 'read' })
    } catch {
      d.recordState = 'failed'
    }
    render()
  }

  async function addTo(d: DatasetItem, files: File[]): Promise<void> {
    for (const file of files) {
      if (file.size > 50e6) { alert(`${file.name} is larger than 50 MB.`); continue }
      d.files.push({ file, detail: await describe(file) })
    }
  }

  /** Files added together: data files, with any README among them, form one dataset; documents on their own stay documents. */
  async function add(files: File[]): Promise<void> {
    const usable = files.filter((f) => !f.name.startsWith('.'))
    const data = usable.filter((f) => DATASET.test(f.name))
    if (data.length) {
      const relative = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? ''
      const folderName = relative(usable[0]).split('/')[0]
      const d: DatasetItem = { name: folderName || data[0].name.replace(/\.[^.]+$/, ''), files: [], producedBy: 'authors', doi: '', version: '', describedIn: '', licence: '', private: true }
      await addTo(d, usable)
      if (d.files.length) datasets.push(d)
    } else {
      for (const file of usable) {
        if (file.size > 50e6) { alert(`${file.name} is larger than 50 MB.`); continue }
        items.push({ name: file.name, kind: 'document', file, detail: await describe(file), private: false })
      }
    }
    render()
  }

  // ---------------------------------------------------------------- 3. settings
  const modelPlan = () => context?.choices?.[[...settings.families].sort().join(',')] ?? context
  function settingsStep(): (Node | null)[] {
    // A paper that rests only on its world model searches nothing else.
    const onlyModel = !!worldModel?.only
    const field = (label: string, control: Node, help?: string) => h('div', { class: 'gw-field' }, h('div', { class: 'gw-label', text: label }), control, help ? h('p', { class: 'gw-help', text: help }) : null)
    const input = (key: 'author' | 'affiliation' | 'venue', placeholder: string, list?: string) => {
      const el = h('input', { class: 'gw-input', value: settings[key], placeholder, 'aria-label': placeholder, ...(list ? { list } : {}) })
      el.addEventListener('input', () => { settings[key] = el.value })
      return el
    }
    const area = (key: 'funding' | 'competingInterests' | 'acknowledgements', placeholder: string) => {
      const el = h('textarea', { class: 'gw-input gw-area', rows: 2, placeholder, 'aria-label': placeholder })
      el.value = settings[key]
      el.addEventListener('input', () => { settings[key] = el.value })
      return el
    }
    const seats = context?.choices ? modelPlan()!.seats : dealSeats(context, settings.families)
    const seatRow = (seat: string, s?: Seat) => h('tr', {}, h('th', { text: seat }), h('td', { text: s?.name ?? '—' }), h('td', { class: 'gw-mono', text: s?.model ?? '' }))
    const familyBox = (f: Seat) => {
      const on = settings.families.includes(f.family)
      const box = h('input', { type: 'checkbox', 'aria-label': f.name, ...(on ? { checked: true } : {}), ...(on && settings.families.length <= 2 ? { disabled: true } : {}) })
      box.addEventListener('change', () => { settings.families = box.checked ? FAMILY_ORDER.filter((x) => x === f.family || settings.families.includes(x)) : settings.families.filter((x) => x !== f.family); render() })
      return h('label', { class: 'gw-check' }, box, h('span', { text: f.name }), h('span', { class: 'gw-mono gw-help', text: f.model }))
    }
    const families = context?.families ?? FAMILY_ORDER.map((family) => Object.values(context?.seats ?? {}).find((s) => s.family === family)).filter((s): s is Seat => !!s)
    const literature = h('p', { class: 'gw-facts' }, 'Canary over OpenAlex · ', context ? (context.openalexKey ? h('span', { text: 'key found' }) : h('span', { class: 'gw-attention', text: 'no key: about 100 searches a day for everyone on this network' })) : 'checking…')
    if (thesis()) return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'How the thesis is made' }),
      field('Author', h('div', { class: 'gw-pair' }, input('author', 'Name'), input('affiliation', 'Affiliation')), 'Set in the brief\'s byline; never sent to a model.'),
      field('Models', h('div', { class: 'gw-stack' }, ...families.map(familyBox)), 'Choose the families for this thesis. The exact models come from Settings → Models.'),
      field('Seats', h('table', { class: 'gw-seats' }, h('tbody', {}, seatRow('author', seats.author), seatRow('challenger', seats.challenger))), 'The author formulates the thesis; the challenger, from another family, tests it for its direction.'),
      field('Literature', literature, `A literature review by Canary, its question leaning toward the direction you chose: at least ${context?.review?.papers ?? 50} full papers read and every finding audited by a second model. A thesis is formulated from the literature only.`),
    ]
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'How the paper is made' }),
      field('Author', h('div', { class: 'gw-pair' }, input('author', 'Name'), input('affiliation', 'Affiliation')), 'Set in the byline when the paper is typeset; never sent to a model.'),
      field('Declarations', h('div', { class: 'gw-stack' }, area('funding', 'Funding'), area('competingInterests', 'Competing interests'), area('acknowledgements', 'Acknowledgements')), 'Printed as you write them; never sent to a model. Left empty, they stay out of the paper, and the sign-off sheet asks for them.'),
      field('Venue', h('span', {}, input('venue', 'Venue', 'gw-venues'), h('datalist', { id: 'gw-venues' }, ...['preprint (arXiv)', 'preprint (bioRxiv)', 'preprint (medRxiv)', 'preprint (SSRN)', 'preprint (EdArXiv)', 'journal article'].map((v) => h('option', { value: v })))), 'Shapes the outline and how the referees read the paper.'),
      field('Length', segmented([3000, 5000, 7000, 9000].map((w) => [`${n(w)} words`, w] as [string, number]), settings.words, (v) => { settings.words = v; render() }, 'Length')),
      field('Also include', h('div', { class: 'gw-choices' }, onlyModel ? h('p', { class: 'gw-help', text: 'No systematic review: the paper\'s sources are only its world model\'s.' }) : toggle('literatureReview', 'Systematic literature review', `Canary searches OpenAlex, screens the candidates, reads at least ${context?.review?.papers ?? 50} full papers and has every finding audited by a second model.`, 'A review section after the introduction, beside the paper\'s own contribution; it runs alongside the other steps.', 'The paper is the systematic review: its thesis and contribution are what the review establishes, and the plan waits for the review to finish.'), toggle('simulation', 'Monte Carlo simulation', 'The author designs the simulation the argument needs (plain, correlated or sequential Monte Carlo) and galley runs it on this machine; every simulated number in the paper is filled in from the run.', 'Its results support the paper\'s own contribution where they help.', 'The paper\'s thesis rests on what the simulation shows: its contribution claims are claims about the results, and the paper is built around the model.'))),
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
      field('Models', h('div', { class: 'gw-stack' }, ...families.map(familyBox)), 'Choose the families for this paper. The exact models come from Settings → Models. You can change the families later in the project.'),
      field('Seats', h('table', { class: 'gw-seats' }, h('tbody', {}, seatRow('author', seats.author), seatRow('checker', seats.checker), seatRow('challenger', seats.challenger), seatRow('verifier', seats.verifier))), 'The review plan shows the referee and adjudicator assignments.'),
      field('Web sources', (() => {
        const box = h('input', { type: 'checkbox', 'aria-label': 'Primary sources from the web', ...(settings.webSources && !onlyModel ? { checked: true } : {}), ...(onlyModel ? { disabled: true } : {}) })
        box.addEventListener('change', () => { settings.webSources = box.checked; render() })
        return h('label', { class: 'gw-check' }, box, h('span', { text: 'Primary sources from the web' }))
      })(), onlyModel ? 'Off: the paper\'s sources are only its world model\'s.' : 'When the scholarly index has no source for a claim, GPT searches the web for the issuer\'s own document: rules, standards, specifications, datasheets, official reports. galley keeps a copy, and each passage is verified by another family like any citation.'),
      field('Literature', onlyModel
        ? h('p', { class: 'gw-facts', text: `The world model "${worldModel?.name ?? worldModel?.file}": its ${n(worldModel?.sources ?? 0)} sources are searched for every claim; no other literature.` })
        : h('p', { class: 'gw-facts' }, worldModel ? 'The world model first, then Canary over OpenAlex · ' : 'Canary over OpenAlex · ', context ? (context.openalexKey ? h('span', { text: 'key found: two searches per claim' }) : h('span', { class: 'gw-attention', text: 'no key: one search per claim, about 100 searches a day for everyone on this network' })) : 'checking…')),
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
    box.addEventListener('change', () => {
      if (key === 'literatureReview') reviewChosen = true
      settings[key] = box.checked
      render()
    })
    const option = h('label', { class: 'gw-choice' }, box, h('span', {}, h('span', { class: 'gw-choice-label', text: label }), h('span', { class: 'gw-help', text: help })))
    if (!settings[key]) return option
    if (softwareRole === 'introduction') return h('div', { class: 'gw-option' }, option, h('p', { class: 'gw-help gw-role', text: supporting }))
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
    const route = modelPlan()
    const s = context?.choices ? route!.seats : dealSeats(context, settings.families)
    const m = (seat: SeatName) => s[seat]?.model ?? seat
    if (thesis()) return thesisStart(m)
    const subject = softwareSubject(softwareLink)
    const simulationRole = softwareRole === 'introduction' ? 'supporting' : settings.simulationRole
    const reviewRole = softwareRole === 'introduction' ? 'supporting' : settings.reviewRole
    const searches = context?.openalexKey ? 'two' : 'one'
    const onlyModel = !!worldModel?.only
    // A step that runs alongside the others shows its own time but adds little to the whole.
    const plan: [string, string, string, number | null, boolean?][] = [
      ['Read your seed', 'claims, concern, contribution and host field', m('author'), 1],
      ...(items.length || datasets.length ? [['Read your materials', datasets.length ? 'profile datasets here; read documents and links' : 'read documents and links', 'this machine', 1] as [string, string, string, number]] : []),
      ...(subject ? [[softwareRole === 'instrument' ? 'Use as an instrument' : 'Introduce our software', `${subject.name} · ${subject.commit.slice(0, 12)} · ${softwareRole === 'instrument' ? 'capture study results' : 'run validation, benchmarks and profiling'}`, `${m('author')} · this machine`, null] as [string, string, string, null]] : []),
      ['Place the idea', onlyModel ? '7 searches of the world model: closest work, bottleneck, consensus' : `7 literature searches${worldModel ? ' of the world model, then' : ''} through Canary: closest work, bottleneck, consensus`, m('checker'), 3],
      ['Challenge the idea', 'seven impact factors; three directions; one chosen', `${m('challenger')} · ${m('checker')}`, 10],
      ...(settings.literatureReview && !onlyModel ? [['Systematic review', `Canary: search plan, screening, at least ${context?.review?.papers ?? 50} full papers read, every finding audited without a fixed time limit; ${reviewRole === 'load-bearing' ? 'the paper\'s main contribution, so the plan waits for it' : 'alongside the steps below'}`, `${context?.review?.research ?? 'gpt-6.1-sol'} research · ${context?.review?.audit ?? 'gpt-6.1-sol'} audit`, 40, reviewRole !== 'load-bearing'] as [string, string, string, number, boolean]] : []),
      ...(datasets.length ? [['Measure your data', 'the analyses the claims need, computed on this machine', `${m('author')} · this machine`, 3] as [string, string, string, number]] : []),
      ...(settings.simulation ? [['Simulate', `the author writes the Monte Carlo model and the basis of every input; galley runs it on this machine${simulationRole === 'load-bearing' ? '; the paper\'s main contribution rests on it' : ''}`, `${m('author')} · this machine`, 5] as [string, string, string, number]] : []),
      ['Plan and outline', 'thesis, claims, sections, figures', m('author'), 8],
      ['Find and verify evidence', `${onlyModel ? 'the world model searched for each claim' : `${worldModel ? 'the world model, then ' : ''}${searches} search${searches === 'one' ? '' : 'es'} per claim`}; verbatim passages; another family's verdict; planted-defect calibration`, `${m('checker')} · ${m('verifier')}`, 20],
      ['Draft', 'every section, checked against its claims', `${m('author')} · ${m('checker')}`, 25],
      ['Review', `${settings.rounds} round${settings.rounds === 1 ? '' : 's'} of four referees; each answer judged by the referee who raised it${route?.adjudicator ? `; disputes: ${route.adjudicator}` : ''}`, (route?.refereeModels ?? []).join(' · '), 50 * settings.rounds],
      ['Finish', 'ledger reconciled with the text; title and abstract; typeset', `${m('checker')} · ${m('author')}`, 10],
    ]
    const total = plan.reduce((a, p) => a + (p[4] ? 5 : p[3] ?? 0), 0) + Math.round((settings.words - 7000) / 1000) * 3
    const leaves = [
      [items.length ? 'Your seed, documents and links' : 'Your seed', `go to ${route?.providers?.join(', ') || 'the selected model providers'}.`],
      ...(datasets.some((d) => d.private) ? [['Private datasets', 'never leave this machine; the models see column summaries and computed results.']] : []),
      ...(datasets.some((d) => !d.private) ? [['Shared datasets', 'their summaries and first 15 rows go to the model providers.']] : []),
      ...(worldModel ? [['World model', 'stays on this machine; its claims and passages closest to the paper go to the model providers.']] : []),
      ...(onlyModel ? [] : [['Search terms', 'go to OpenAlex through Canary.']]),
      ...(settings.webSources && !onlyModel ? [['Web searches', 'for primary sources: the claims\' own terms go to OpenAI\'s web search, and the documents are fetched from their publishers.']] : []),
      ...(settings.literatureReview && !onlyModel ? [['Review question', 'goes to Canary\'s research and audit models (OpenAI) and to OpenAlex.']] : []),
      ['Your name', 'is never sent; it is set in the byline at typesetting.'],
    ]
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'What happens when you start' }),
      h('ol', { class: 'gw-plan' }, ...plan.map(([what, detail, who, mins]) => h('li', {},
        h('span', { class: 'gw-plan-what' }, h('strong', { text: what }), h('span', { class: 'gw-help', text: detail }), h('span', { class: 'gw-mono gw-plan-who', text: who })),
        mins === null ? null : h('span', { class: 'gw-mono gw-plan-time', text: minutes(mins) })))),
      h('p', { class: 'gw-facts' }, 'About ', h('strong', { text: minutes(Math.max(60, total)) }), ` for ${n(settings.words)} words${subject ? ', plus software evaluation time' : ''}. Nothing needs you until the paper is ready${settings.dial === 'autonomous' && settings.citations === 'auto' ? '' : ', except the choices you asked for'}.`),
      h('div', { class: 'gw-box' }, h('div', { class: 'gw-label', text: 'What leaves this machine' }), h('dl', { class: 'gw-leaves' }, ...leaves.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))),
      h('p', { class: 'gw-note', text: 'Starting moves your seed into the paper\'s settings and turns this document into the paper. It grows here, every referee finding becomes a thread under its passage, and you can edit and comment while the team works.' }),
    ]
  }

  function thesisStart(m: (seat: SeatName) => string): (Node | null)[] {
    const [, name, flow] = STANCES.find(([value]) => value === settings.stance) ?? STANCES[0]
    const plan: [string, string, string, number][] = [
      ['Read your seed', 'its concern, its subject and its field', m('author'), 1],
      ['Place the idea', '7 literature searches through Canary: closest work, bottleneck, consensus', m('checker'), 3],
      ['Literature review', `Canary, its question leaning ${flow.toLowerCase()}: search plan, screening, at least ${context?.review?.papers ?? 50} full papers read, every finding audited`, `${context?.review?.research ?? 'gpt-6.1-sol'} research · ${context?.review?.audit ?? 'gpt-6.1-sol'} audit`, 40],
      ['Formulate the thesis', `${name.toLowerCase()}: the field's positions mapped from the review, one thesis taken against them, what it holds under, depends on and opens`, m('author'), 5],
      ['Test it', 'searches for work already stating it; another family\'s verdict for its direction; formulated again once if it misses', `${m('challenger')} · Canary`, 5],
      ['Write the brief', 'into this document, with a PDF beside it', 'this machine', 1],
    ]
    const leaves = [
      ['Your seed', `goes to ${modelPlan()?.providers?.join(', ') || 'the selected model providers'}.`],
      ['Search terms', 'go to OpenAlex through Canary.'],
      ['Review question', 'goes to Canary\'s research and audit models (OpenAI) and to OpenAlex.'],
      ['Your name', 'is never sent; it is set in the brief\'s byline.'],
    ]
    return [
      h('h2', { id: 'gw-title', class: 'gw-title', text: 'What happens when you start' }),
      h('ol', { class: 'gw-plan' }, ...plan.map(([what, detail, who, mins]) => h('li', {},
        h('span', { class: 'gw-plan-what' }, h('strong', { text: what }), h('span', { class: 'gw-help', text: detail }), h('span', { class: 'gw-mono gw-plan-who', text: who })),
        h('span', { class: 'gw-mono gw-plan-time', text: minutes(mins) })))),
      h('p', { class: 'gw-facts' }, 'About ', h('strong', { text: minutes(plan.reduce((a, p) => a + p[3], 0)) }), '. Nothing needs you until the brief is ready.'),
      h('div', { class: 'gw-box' }, h('div', { class: 'gw-label', text: 'What leaves this machine' }), h('dl', { class: 'gw-leaves' }, ...leaves.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))),
      h('p', { class: 'gw-note', text: 'When the brief is ready it replaces the seed in this document; the seed stays in the project\'s settings. Explore the thesis further, then start a paper from it.' }),
    ]
  }

  async function start(): Promise<void> {
    if (starting) return
    starting = true
    next.disabled = true
    back.disabled = true
    next.textContent = 'Starting…'
    // A thesis takes no materials, a world model among them, even one still on the paper's Materials step.
    const model = thesis() ? null : worldModel
    try {
      if (model && model.state !== 'read') throw new Error(model.state === 'reading' ? 'The world model is still being read; start again in a moment.' : 'The world model could not be read; remove it or choose it again.')
      // A thesis is formulated from the literature only: no materials go with it.
      if (thesis()) { items.length = 0; datasets.length = 0 }
      const materials = await Promise.all(items.map(async (item) => item.kind === 'link'
        ? { name: item.name, url: item.url }
        : { name: item.name, private: item.private, data: await base64(item.file!) }))
      const sets = await Promise.all(datasets.map(async (d) => d.db
        // A database: where it was found (or its saved connection's name) and which one; the server keeps the connection.
        ? { database: d.db, name: d.name, producedBy: d.producedBy, private: d.private }
        : d.record
        // A dataset by its link: the engine reads the record and downloads its files; the person's answers go with it.
        ? { record: d.record, name: d.recordState === 'read' ? d.name : '', producedBy: d.producedBy, describedIn: d.describedIn, private: d.private }
        : {
          name: d.name, producedBy: d.producedBy, doi: d.doi, version: d.version, describedIn: d.describedIn, licence: d.licence, private: d.private,
          files: await Promise.all(d.files.map(async (f) => ({ name: f.file.name, data: await base64(f.file) }))),
        }))
      const response = await fetch(`/api/galley-papers/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text, materials, datasets: sets, modelRevision: context?.modelRevision,
          ...(!thesis() && softwareLink.trim() ? { softwareCommit: softwareSubject(softwareLink)?.url, softwareRole } : {}),
          // With only its world model, the paper has no systematic review and no web sources.
          settings: { ...settings,
            families: settings.families.length < (context?.families?.length ?? FAMILY_ORDER.length) ? settings.families : undefined,
            ...(model?.only ? { literatureReview: false, webSources: false } : {}),
            ...(softwareRole === 'introduction' && !thesis() ? { reviewRole: 'supporting', simulationRole: 'supporting' } : {}),
          },
          ...(model?.token ? { worldModel: { token: model.token, only: model.only } } : {}),
        }),
      })
      if (response.status === 409 && (await response.clone().text()).startsWith('Model settings changed.')) {
        context = await readContext()
        const available = context.families?.map((f) => f.family) ?? FAMILY_ORDER
        const selected = settings.families.filter((f) => available.includes(f))
        settings.families = selected.length >= 2 ? selected : available
        render()
      }
      if (!response.ok) throw new Error(await response.text())
      started = true
      const at = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      trail.querySelectorAll('li').forEach((li) => li.classList.add('is-done'))
      body.replaceChildren(
        h('h2', { id: 'gw-title', class: 'gw-title' }, h('span', { class: 'gw-lamp', 'aria-hidden': 'true' }), thesis() ? 'Formulating the thesis' : 'Writing the paper'),
        h('p', { class: 'gw-lead' }, `Started at ${at}. `, h('span', { class: 'gw-mono', text: context?.seats.author.model ?? 'The author' }), ' is reading your seed.'),
        h('p', { class: 'gw-note', text: thesis()
          ? 'The brief is written into this document when it is ready, in about an hour. Your seed is kept in the project\'s settings; press the play button any time to see where the thesis stands.'
          : 'This document is now the paper: the team writes it here, and you can edit and comment while they work. Your seed is kept in the paper\'s settings; press the paper button any time to see it and where the paper stands.' }),
        seedReference(text),
      )
      back.hidden = true
      next.disabled = false
      next.textContent = options.onStart ? (thesis() ? 'Open the thesis' : 'Open the paper') : 'Close'
      next.onclick = () => { dialog.close(); options.onStart?.(slug) }
      hint.textContent = ''
    } catch (error) {
      starting = false
      next.disabled = false
      back.disabled = false
      next.textContent = thesis() ? 'Start the thesis' : 'Start the paper'
      body.append(h('p', { class: 'gw-error', role: 'alert', text: `The ${thesis() ? 'thesis' : 'paper'} did not start: ${(error as Error).message}` }))
    }
  }

  return dialog
}

interface StatusData {
  slug: string
  title: string | null
  seedTitle: string
  softwareCommit?: string
  softwareRole?: SoftwareRole
  outcome: string | null
  /** Defects a reader would see that a finished paper's last reading left open. */
  open?: number
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
  seed: string
  /** A thesis run: its direction, and the thesis once formulated, with whether it met its test. */
  mode?: 'paper' | 'thesis'
  stance?: string
  thesis?: { statement: string; passes: boolean | null; searched?: number | null; testOff?: boolean } | null
  settings: { literatureReview: boolean | string; simulation: boolean | string; rounds: number; words: number; venue: string; authors: string[]; materials: string[]; families?: string[]; availableFamilies?: string[]; seats?: Record<string, string> }
}

const clock = (iso: string | Date) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const ago = (seconds: number) => seconds < 90 ? `${seconds} s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`

/** What the project was started with: its options, people and materials. */
function settingRows(d: StatusData): [string, string][] {
  const part = (v: boolean | string) => v === 'load-bearing' ? 'yes, the main contribution' : v ? 'yes, supporting' : 'no'
  const models: [string, string] = ['Models', `${(d.settings.families ?? FAMILY_ORDER).map((f) => FAMILY_LABEL[f] ?? f).join(', ')}${d.settings.seats ? ` · ${d.settings.seats.author} writes` : ''}`]
  if (d.mode === 'thesis') {
    const stance = STANCES.find(([value]) => value === d.stance)
    return [['Direction', stance ? `${stance[1]}: ${stance[2].toLowerCase()}` : 'extend'], ['Authors', d.settings.authors.join('; ') || 'not set'], models]
  }
  return [
    ['Literature review', part(d.settings.literatureReview)],
    ['Simulation', part(d.settings.simulation)],
    ['Length', `${d.settings.words.toLocaleString('en-US')} words · ${d.settings.rounds} referee round${d.settings.rounds === 1 ? '' : 's'} · ${d.settings.venue}`],
    ['Authors', d.settings.authors.join('; ') || 'not set'],
    ['Materials', d.settings.materials.join('; ') || 'none'],
    ['Models', `${(d.settings.families ?? FAMILY_ORDER).map((f) => FAMILY_LABEL[f] ?? f).join(', ')}${d.settings.seats ? ` · ${d.settings.seats.author} writes` : ''}`],
  ]
}

const FAMILY_LABEL: Record<string, string> = { claude: 'Claude Opus 5.5', gpt: 'GPT-6.2 Sol', gemini: 'Gemini 4 Carbon' }

/** Where a paper stands, kept current while the window is open. The dialog is returned so a host can tell when it closes. */
export function openPaperStatus(slug: string, open?: (manuscript: string) => void): HTMLDialogElement {
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

  /** The project's model families, changed here: a running paper deals its seats again at its next step. */
  const modelsControl = (d: StatusData) => {
    const current = d.settings.families ?? FAMILY_ORDER
    const note = h('p', { class: 'gw-help', text: 'Changing the families updates future work using the models saved with this project.' })
    const available = d.settings.availableFamilies ?? FAMILY_ORDER
    const boxes = available.map((family) => {
      const on = current.includes(family)
      const box = h('input', { type: 'checkbox', 'aria-label': FAMILY_LABEL[family], ...(on ? { checked: true } : {}), ...(on && current.length <= 2 ? { disabled: true } : {}) })
      box.addEventListener('change', async () => {
        const next = box.checked ? available.filter((x) => x === family || current.includes(x)) : current.filter((x) => x !== family)
        note.textContent = 'Saving …'
        const response = await fetch(`/api/galley-papers/${encodeURIComponent(slug)}/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ families: next }) })
        note.textContent = response.ok ? 'Saved. The paper follows from its next step.' : `Not saved: ${await response.text()}`
        void load()
      })
      return h('label', { class: 'gw-check' }, box, h('span', { text: FAMILY_LABEL[family] }))
    })
    return h('div', { class: 'gw-field' }, h('div', { class: 'gw-label', text: 'Models' }), h('div', { class: 'gw-stack' }, ...boxes), note)
  }

  const draw = (d: StatusData) => {
    // The window redraws every 10 s; what the person unfolded to read, and where they scrolled, stays put.
    const seedOpen = !!body.querySelector<HTMLDetailsElement>('details.gw-seed')?.open
    const scroll = body.scrollTop
    const current = d.stages.findIndex((s) => !s.done)
    const isThesis = d.mode === 'thesis'
    const subject = d.softwareCommit && softwareSubject(d.softwareCommit)
    const done = d.outcome === 'ready_for_submission' || d.outcome === 'thesis_ready'
    // A paper that finished with defects a reader would see still open says so, and how many.
    const withOpen = d.outcome === 'finished_with_open_defects'
    const state = done
      ? h('p', { class: 'gw-state is-done' }, h('span', { class: 'gw-state-mark', 'aria-hidden': 'true', text: '✓' }), isThesis ? 'Ready: the brief is in this document' : 'Ready for submission')
      : withOpen
      ? h('p', { class: 'gw-state is-stopped' }, h('span', { class: 'gw-state-mark', 'aria-hidden': 'true', text: '!' }), `Finished, with ${d.open ?? 0} defect${d.open === 1 ? '' : 's'} open: the sign-off lists them`)
      : d.running
        ? h('p', { class: 'gw-state' }, h('span', { class: 'gw-lamp', 'aria-hidden': 'true' }), `Running · ${d.stages[current]?.label ?? 'Finishing'}`)
        : h('p', { class: 'gw-state is-stopped' }, h('span', { class: 'gw-state-mark', 'aria-hidden': 'true', text: '‖' }), d.outcome ? `Ended: ${d.outcome.replace(/_/g, ' ')}` : 'Not running')
    const n = (x: number | null) => x === null ? '…' : x.toLocaleString('en-US')
    const rows: [string, string][] = isThesis ? [
      ['Thesis', d.thesis?.statement ?? 'not formulated yet'],
      ['Test', !d.thesis ? 'not yet' : d.thesis.passes === null ? (d.thesis.testOff ? 'turned off for this run' : 'not yet') : `${d.thesis.passes ? 'meets the test for its direction' : 'does not yet meet the test for its direction'}${d.thesis.searched === null ? ', without a novelty search' : ''}`],
      ['So far', `${n(d.cost.calls)} model calls · ${d.cost.tokensInM} M tokens · ${d.cost.hours} h`],
    ] : [
      ['Claims', `${n(d.claims.total)}: ${d.claims.supported + d.claims.narrowed} with verified sources, ${d.claims.own} your work, ${d.claims.premises} premises, ${d.claims.hypotheses} hypotheses, ${d.claims.open} still open`],
      ['Evidence', `${n(d.evidence.screened)} works screened · ${d.evidence.verified} citations verified · ${d.evidence.rejected} rejected`],
      ['Sections', d.sections.total === null ? 'not outlined yet' : `${d.sections.drafted} of ${d.sections.total} drafted`],
      ['Review', d.review.round ? `round ${d.review.round} of ${d.review.rounds} · ${d.review.findings} findings, ${d.review.open} open` : `${d.review.rounds} round${d.review.rounds === 1 ? '' : 's'}, after the draft`],
      ['So far', `${n(d.cost.calls)} model calls · ${d.cost.tokensInM} M tokens · ${d.cost.hours} h`],
    ]
    body.replaceChildren(...[
      h('div', { class: 'gw-label', text: isThesis ? 'Thesis' : 'Paper' }),
      h('h2', { id: 'gw-title', class: 'gw-title', text: d.title ?? d.seedTitle ?? (isThesis ? 'Untitled thesis' : 'Untitled paper') }),
      state,
      h('p', { class: 'gw-note', text: `Started ${clock(d.startedAt)}${d.title ? ` · from “${d.seedTitle.length > 70 ? `${d.seedTitle.slice(0, 70)}…` : d.seedTitle}”` : ''}` }),
      subject ? h('p', { class: 'gw-note' }, `${SOFTWARE_ROLES.find(([role]) => role === (d.softwareRole ?? 'introduction'))?.[1] ?? 'Software'} · `, h('a', { href: subject.url, target: '_blank', rel: 'noopener', title: subject.commit, text: `${subject.name} · ${subject.commit.slice(0, 12)}` })) : null,
      h('ol', { class: d.stages.length > 7 ? 'gw-stages gw-stages--dense' : 'gw-stages' }, ...d.stages.map((s, i) => h('li', { class: s.done ? 'is-done' : i === current && !done ? 'is-current' : '' },
        h('span', { class: 'gw-num', text: s.done ? '✓' : String(i + 1) }), h('span', { class: 'gw-stage', text: s.label })))),
      d.running && d.now.length
        ? h('div', { class: 'gw-box' }, h('div', { class: 'gw-label', text: 'Now' }), ...d.now.map((f) => h('p', { class: 'gw-now' }, h('span', { class: 'gw-now-what' }, h('strong', { text: f.doing }), h('span', { class: 'gw-mono gw-now-who', text: f.who })), h('span', { class: 'gw-mono gw-now-time', text: ago(f.seconds) }))))
        : d.running && d.waiting ? h('div', { class: 'gw-box' }, h('div', { class: 'gw-label', text: 'Now' }), h('p', { class: 'gw-now' }, h('span', { class: 'gw-now-what' }, h('strong', { text: `Waiting for ${d.waiting.name}` }), h('span', { class: 'gw-now-who', text: d.waiting.resetsIn === null ? 'Usage limit; it carries on by itself.' : d.waiting.resetsIn > 0 ? `Usage quota; resets in ${ago(d.waiting.resetsIn)}.` : 'Usage quota has reset.' })), h('span', { class: 'gw-mono gw-now-time', text: `next try in ${ago(d.waiting.seconds)}` })))
        : d.running ? h('div', { class: 'gw-box' }, h('div', { class: 'gw-label', text: 'Now' }), h('p', { class: 'gw-now' }, h('span', { class: 'gw-help', text: 'Between steps; the next one starts in a moment.' }))) : null,
      h('dl', { class: 'gw-figures' }, ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      h('details', { class: 'gw-seed', open: seedOpen }, h('summary', { text: 'Settings and seed' }),
        h('dl', { class: 'gw-figures' }, ...settingRows(d).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
        modelsControl(d),
        h('blockquote', { class: 'gw-quote', text: d.seed || '(empty)' })),
    ].filter((x) => !!x) as HTMLElement[])
    body.scrollTop = scroll
    // The paper is this document now; a project from before has its own document to open.
    openButton.hidden = !(d.typeset && open) || d.slug === slug
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
  return dialog
}

export type { EditorAction }
