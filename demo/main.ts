// The demo host: what adopting Galley looks like in an app. It picks a store,
// adds one action of its own, and hides its own header in writer mode.
import '../src/styles/tokens.css'
import '../src/styles/galley.css'
import './demo.css'
import welcome from './welcome.md?raw'
import { createEditor, createHttpStore, createLocalStore, icons, type EditorAction } from '../src/index.js'
import { choicesAction } from './choices.js'
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
  toolbar: ['writer', 'new', 'import', 'copy', download, ...(local ? [] : [writePaperAction(), choicesAction(), proposalsAction()]), 'delete'],
  storagePrefix: local ? 'galley-local' : 'galley',
})

editor.on('writer-mode', ({ on }) => document.body.classList.toggle('is-writing', on))

document.documentElement.dataset.theme = theme
document.getElementById('demo-where')!.textContent = local ? 'documents in this browser' : 'documents in .galley-data/'
const storeLink = document.getElementById('demo-store') as HTMLAnchorElement
storeLink.textContent = local ? 'Use files' : 'Use browser storage'
storeLink.href = `?${new URLSearchParams({ ...(local ? {} : { store: 'local' }), ...(theme === 'light' ? { theme } : {}) })}`
const themeButton = document.getElementById('demo-theme')!
themeButton.textContent = theme === 'light' ? 'Dark' : 'Light'
themeButton.addEventListener('click', () => {
  const next = new URLSearchParams(location.search)
  if (theme === 'light') next.delete('theme')
  else next.set('theme', 'light')
  location.search = next.toString()
})

// For poking at from the console, and for the end-to-end tests.
;(window as unknown as { galley: typeof editor }).galley = editor
