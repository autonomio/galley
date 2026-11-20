// The demo host: what adopting Galley looks like in an app. It picks a store,
// adds actions of its own, and puts its name and its own controls in the
// editor's row, so the whole top of the page is one row.
import '../src/styles/tokens.css'
import '../src/styles/galley.css'
import './demo.css'
import './wizard.css'
import './files.css'
import './living.css'
import welcome from './welcome.md?raw'
import { createEditor, createHttpStore, createLocalStore, iconButton, icons, type EditorAction } from '../src/index.js'
import { choicesAction } from './choices.js'
import { filesAction } from './files.js'
import { livingPaper } from './living.js'
import { writePaperAction } from './paper.js'
import { proposalsAction } from './proposals.js'
import { createRouter } from './route.js'

const params = new URLSearchParams(location.search)
const local = params.get('store') === 'local'
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

const editor = createEditor(document.getElementById('editor')!, {
  store,
  theme,
  placeholder: 'Start writing…',
  // ?doc=<name> opens that document, so a paper can be linked to directly.
  open: router.route().doc ?? undefined,
  // Grouped: the view; the document; the paper written from it, and its files; and, on its own, delete.
  toolbar: ['writer', '|', 'new', 'import', 'copy', download, ...(local ? [] : ['|' as const, writePaperAction(router), choicesAction(router), proposalsAction(router), filesAction(router)]), '|', 'delete'],
  storagePrefix: local ? 'galley-local' : 'galley',
  // A paper's document is written by its team while you work in it: who is at work, its notes and its history.
  plugins: local ? [] : [livingPaper(store, router)],
})
router.view('writer', { set: (on, e) => e.setWriterMode(on) })
editor.on('writer-mode', ({ on }) => router.shown('writer', on))
router.attach(editor)

document.documentElement.dataset.theme = theme

// The host's own controls, in the editor's row: its name first; where the
// documents are kept and the theme last, after a divider.
const name = document.createElement('span')
name.className = 'demo-name'
name.textContent = 'Galley'
// Every paper at once, on a page of its own: /papers/ (overview.ts).
const papersPage = iconButton({
  label: 'All papers',
  description: 'Every paper on one page: whether it is being written, where it stands, who is at work on what, and how far it has come.',
  icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.75" y="2.75" width="4" height="4" rx="1"/><rect x="9.25" y="2.75" width="4" height="4" rx="1"/><rect x="2.75" y="9.25" width="4" height="4" rx="1"/><rect x="9.25" y="9.25" width="4" height="4" rx="1"/></svg>',
  className: 'demo-papers',
  onClick: () => location.assign(`/papers/${theme === 'light' ? '?theme=light' : ''}`),
})
editor.slot('bar-start').append(name, ...(local ? [] : [papersPage]))
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

// For poking at from the console, and for the end-to-end tests.
;(window as unknown as { galley: typeof editor }).galley = editor
