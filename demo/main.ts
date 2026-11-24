// The demo host: what adopting Galley looks like in an app. It picks a store,
// adds one action of its own, and hides its own header in writer mode.
import '../src/styles/tokens.css'
import '../src/styles/galley.css'
import './demo.css'
import './wizard.css'
import './living.css'
import welcome from './welcome.md?raw'
import { createEditor, createHttpStore, createLocalStore, icons, type EditorAction } from '../src/index.js'
import { choicesAction } from './choices.js'
import { livingPaper } from './living.js'
import { writePaperAction } from './paper.js'
import { mountModelSettings } from './model-settings.js'
import { proposalsAction } from './proposals.js'

const params = new URLSearchParams(location.search)
const local = params.get('store') === 'local'
// Hosted builds provide the file-backed editor. The paper engine belongs to the
// developer host, where its three native model sessions and typesetter run.
const papersEnabled = !local && import.meta.env.DEV
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

document.documentElement.dataset.theme = theme
document.getElementById('demo-where')!.textContent = local ? 'documents in this browser' : 'documents on the server'
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

const settingsLink = document.getElementById('demo-settings') as HTMLAnchorElement
const settingsURL = new URL(location.href)
const settingsOpen = papersEnabled && params.get('settings') === 'models'
settingsURL.searchParams.set('settings', 'models')
settingsLink.href = settingsURL.href
settingsLink.hidden = !papersEnabled || settingsOpen

if (settingsOpen) {
  settingsURL.searchParams.delete('settings')
  const main = document.querySelector('.demo-main')!
  const settings = document.createElement('main')
  settings.className = 'galley gms'
  settings.dataset.galleyTheme = theme
  main.replaceWith(settings)
  document.title = 'Galley — Settings · Models'
  mountModelSettings(settings, settingsURL.href)
} else {
  const editor = createEditor(document.getElementById('editor')!, {
    store,
    theme,
    placeholder: 'Start writing…',
    toolbar: ['writer', 'new', 'import', 'copy', download, ...(papersEnabled ? [writePaperAction(), choicesAction(), proposalsAction()] : []), 'delete'],
    storagePrefix: local ? 'galley-local' : 'galley',
    // A paper's document is written by its team while you work in it: who is at work, its notes and its history.
    plugins: papersEnabled ? [livingPaper(store, document.getElementById('history')!)] : [],
  })

  editor.on('writer-mode', ({ on }) => document.body.classList.toggle('is-writing', on))

  // For poking at from the console, and for the end-to-end tests.
  ;(window as unknown as { galley: typeof editor }).galley = editor
}
