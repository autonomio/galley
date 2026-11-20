// The demo host: what adopting Galley looks like in an app. It picks a store,
// adds actions of its own, and puts its name and its own controls in the
// editor's row, so the whole top of the page is one row.
import '../src/styles/tokens.css'
import '../src/styles/galley.css'
import './demo.css'
import './wizard.css'
import './living.css'
import welcome from './welcome.md?raw'
import { createEditor, createHttpStore, createLocalStore, iconButton, icons, type EditorAction } from '../src/index.js'
import { choicesAction } from './choices.js'
import { livingPaper } from './living.js'
import { writePaperAction } from './paper.js'
import { proposalsAction } from './proposals.js'

const params = new URLSearchParams(location.search)
const local = params.get('store') === 'local'
const theme = (params.get('theme') === 'light' ? 'light' : 'dark') as 'light' | 'dark'

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
  // Grouped: the view; the document; the paper written from it; and, on its own, delete.
  toolbar: ['writer', '|', 'new', 'import', 'copy', download, ...(local ? [] : ['|' as const, writePaperAction(), choicesAction(), proposalsAction()]), '|', 'delete'],
  storagePrefix: local ? 'galley-local' : 'galley',
  // A paper's document is written by its team while you work in it: who is at work, its notes and its history.
  plugins: local ? [] : [livingPaper(store)],
})

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

// ?doc=<name> opens that document once the editor has loaded, so a paper can be linked to directly.
const linked = params.get('doc')
if (linked && /^[a-z0-9][a-z0-9-]*$/i.test(linked)) {
  const ready = setInterval(() => {
    if (!editor.slug) return
    clearInterval(ready)
    if (editor.slug !== linked) void editor.open(linked)
  }, 50)
}

// For poking at from the console, and for the end-to-end tests.
;(window as unknown as { galley: typeof editor }).galley = editor
