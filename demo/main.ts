// The demo host: what adopting Galley looks like in an app. It picks a store,
// adds actions of its own, and puts its name and its own controls in the
// editor's row, so the whole top of the page is one row.
import '../src/styles/tokens.css'
import '../src/styles/galley.css'
import './demo.css'
import './wizard.css'
import './files.css'
import './living.css'
import './rail.css'
import welcome from './welcome.md?raw'
import { createEditor, createHttpStore, createLocalStore, iconButton, icons, type EditorAction } from '../src/index.js'
import { choicesAction } from './choices.js'
import { filesAction } from './files.js'
import { fetchPapers } from './glance.js'
import { livingPaper } from './living.js'
import { writePaperAction } from './paper.js'
import { mountModelSettings } from './model-settings.js'
import { proposalsAction } from './proposals.js'
import { papersRail } from './rail.js'
import { createRouter } from './route.js'

const params = new URLSearchParams(location.search)
const local = params.get('store') === 'local'
// Hosted builds provide the file-backed editor. The paper engine belongs to the
// developer host, where its three native model sessions and typesetter run.
const papersEnabled = !local && import.meta.env.DEV
const theme = (params.get('theme') === 'light' ? 'light' : 'dark') as 'light' | 'dark'
// The address bar says what is on screen, so any of it can be passed on as a link (route.ts).
const router = createRouter()

const store = local
  ? createLocalStore({ documents: { welcome } })
  : createHttpStore({ baseUrl: '/api/galley' })

// A host action: download the open document as a .md file.
const download: EditorAction = {
  id: 'download',
  label: 'Download as Markdown',
  description: 'Save this document to your computer as a Markdown file.',
  icon: icons.download,
  run(editor) {
    const title = editor.documents().find((d) => d.slug === editor.slug)?.title || 'document'
    const url = URL.createObjectURL(new Blob([editor.text()], { type: 'text/markdown' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `${title.replace(/[\\/:*?"<>|]+/g, '-')}.md` })
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}

const settingsURL = new URL(location.href)
if (papersEnabled && params.get('settings') === 'models') {
  settingsURL.searchParams.delete('settings')
  const settings = document.createElement('main')
  settings.className = 'galley gms'
  settings.dataset.galleyTheme = theme
  document.getElementById('editor')!.replaceWith(settings)
  document.title = 'Galley — Settings · Models'
  document.documentElement.dataset.theme = theme
  mountModelSettings(settings, settingsURL.href)
} else {
  const editor = createEditor(document.getElementById('editor')!, {
    store,
    theme,
    placeholder: 'Start writing…',
    // ?doc=<name> opens that document, so a paper can be linked to directly.
    open: router.route().doc ?? undefined,
    // Grouped: the view and its comments; the document; the paper written from it, and its files; and, on its own, delete.
    toolbar: ['writer', 'comments', '|', 'new', 'import', 'copy', download, ...(papersEnabled ? ['|' as const, writePaperAction(router), choicesAction(router), proposalsAction(router), filesAction(router)] : []), '|', 'delete'],
    storagePrefix: local ? 'galley-local' : 'galley',
    // Deleting a document deletes the project made from it too (vite.config.ts), so the dialog that asks says so.
    deleting: !papersEnabled ? undefined : async (slug) => {
      const project = (await fetchPapers()).find((p) => p.doc === slug)
      if (!project) return null
      return `The document, its notes and the project made from it are deleted: the run, its journal and any PDF.${project.running ? ' Its run is still going and is stopped first.' : ''}`
    },
    // A paper's document is written by its team while you work in it: who is at work, its notes and its history.
    // Every paper beside the page, whichever document is open: where each stands and who is at work on what.
    plugins: papersEnabled ? [livingPaper(store, router), papersRail()] : [],
  })
  router.view('writer', { set: (on, e) => e.setWriterMode(on) })
  editor.on('writer-mode', ({ on }) => router.shown('writer', on))
  router.attach(editor)

  // Comments show unless the link says comments=off. The switch writes it there
  // in place, and Back and Forward bring back what each step's link says.
  const commentsOff = () => new URLSearchParams(location.search).get('comments') === 'off'
  if (commentsOff()) editor.annotations.setVisible(false)
  editor.on('annotations-visible', ({ on }) => {
    const next = new URLSearchParams(location.search)
    if (on) next.delete('comments')
    else next.set('comments', 'off')
    const query = next.toString()
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
  })
  window.addEventListener('popstate', () => editor.annotations.setVisible(!commentsOff()))

  document.documentElement.dataset.theme = theme

  // The host's own controls, in the editor's row: its name first; where the
  // documents are kept and the theme last, after a divider.
  const name = document.createElement('span')
  name.className = 'demo-name'
  name.textContent = 'Galley'
  editor.slot('bar-start').append(name)
  const divider = document.createElement('span')
  divider.className = 'galley-bar-sep'
  divider.setAttribute('role', 'separator')
  const storeSwitch = iconButton({
    label: local ? 'Use files' : 'Use browser storage',
    description: local
      ? 'Documents are kept in this browser now. Switch to the files in .galley-data/.'
      : 'Documents are files in .galley-data/ now. Switch to documents kept in this browser.',
    icon: local ? icons.folder : icons.browser,
    className: 'demo-store',
    onClick: () => { location.search = new URLSearchParams({ ...(local ? {} : { store: 'local' }), ...(theme === 'light' ? { theme } : {}) }).toString() },
  })
  const themeSwitch = iconButton({
    label: theme === 'light' ? 'Dark theme' : 'Light theme',
    description: `Show the page in ${theme === 'light' ? 'dark' : 'light'} colours.`,
    icon: theme === 'light' ? icons.moon : icons.sun,
    onClick: () => {
      const next = new URLSearchParams(location.search)
      if (theme === 'light') next.delete('theme')
      else next.set('theme', 'light')
      location.search = next.toString()
    },
  })
  editor.slot('bar-end').append(divider, storeSwitch, themeSwitch)

  if (papersEnabled) {
    const link = document.createElement('a')
    const url = new URL(location.href)
    url.searchParams.set('settings', 'models')
    link.href = url.href
    link.addEventListener('click', () => {
      const current = new URL(location.href)
      current.searchParams.set('settings', 'models')
      link.href = current.href
    })
    link.className = 'demo-link'
    link.textContent = 'Settings'
    editor.slot('bar-end').append(link)
  }
  ;(window as unknown as { galley: typeof editor }).galley = editor
}
