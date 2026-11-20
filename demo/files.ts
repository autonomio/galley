// A project's files: everything its paper has made, the PDF first, each with a
// link of its own to open, download or pass on. A host action on the left of
// the row; the list is a view of its own (view=files), so it can be linked to
// as well. The files are the paper's out/ folder, served by vite.config.ts.
import { confirmOn, iconButton, icons, type Editor, type EditorAction } from '../src/index.js'
import type { Router } from './route.js'

interface Entry { path: string, size: number, modified: string }
interface Listing { paper: boolean, files: Entry[] }
type Group = 'paper' | 'sources' | 'record' | 'other'
interface Item { name: string, folder: boolean, files: Entry[], group: Group, label: string, detail: string, order: number }

const GROUPS: [Group, string][] = [['paper', 'The paper'], ['sources', 'What it rests on'], ['record', 'The record'], ['other', 'Other files']]

// What the engine's typeset step makes (src/engine/render.ts), as src/engine/self.ts says what each is.
const KNOWN: [name: string, group: Group, label: string, detail: string][] = [
  ['paper.pdf', 'paper', 'Paper', 'The typeset paper'],
  ['paper-review.pdf', 'paper', 'Review copy', 'Line-numbered, for reviewers'],
  ['paper.docx', 'paper', 'Word', 'The paper as a Word document'],
  ['paper.tex', 'paper', 'LaTeX', 'The paper as LaTeX source'],
  ['paper.typ', 'paper', 'Typst', 'The paper as Typst source'],
  ['manuscript.md', 'paper', 'Manuscript', 'The text as Markdown'],
  ['submission.zip', 'paper', 'Submission', 'Every format, with references, evidence and journal'],
  ['refs.bib', 'sources', 'References', 'BibTeX'],
  ['refs.json', 'sources', 'References', 'CSL JSON'],
  ['evidence', 'sources', 'Evidence package', 'Claims, evidence and sources as Resolvent records'],
  ['figures', 'sources', 'Figures', ''],
  ['simulation', 'sources', 'Simulation', ''],
  ['signoff.md', 'record', 'Sign-off sheet', 'What only the authors can decide'],
  ['production-journal.jsonl', 'record', 'Production journal', 'Every step of the run, in order'],
]

const REFRESH_MS = 10_000

const fileUrl = (doc: string, path: string) => `/papers/${encodeURIComponent(doc)}/${path.split('/').map(encodeURIComponent).join('/')}`
const bytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`)
const count = (n: number) => `${n} file${n === 1 ? '' : 's'}`
const extension = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toUpperCase()
const clock = (date: Date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
// A download is named for its document: paper.pdf of trees is trees.pdf, refs.bib is trees-refs.bib.
const saveAs = (doc: string, name: string) => (/^paper[.-]/.test(name) ? name.replace(/^paper/, doc) : `${doc}-${name}`)

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | undefined> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else node.setAttribute(key, value)
  }
  for (const child of children) if (child) node.append(child)
  return node
}

/** The files as the list shows them: one row a file, one row a folder, in the order the paper makes them. */
function itemsOf(files: Entry[]): Item[] {
  const tops = new Map<string, Entry[]>()
  for (const file of files) {
    const top = file.path.split('/')[0]
    tops.set(top, [...(tops.get(top) ?? []), file])
  }
  return [...tops].map(([name, entries]) => {
    const at = KNOWN.findIndex(([known]) => known === name)
    const [, group, label, detail] = at >= 0 ? KNOWN[at] : [name, 'other' as Group, name, '']
    return { name, folder: entries.some((e) => e.path !== name), files: entries, group, label, detail, order: at >= 0 ? at : KNOWN.length }
  }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

function save(href: string, name: string): void {
  h('a', { href, download: name }).click()
}

async function copyLink(button: HTMLButtonElement, href: string): Promise<void> {
  const url = new URL(href, location.href).href
  try {
    await navigator.clipboard.writeText(url)
    confirmOn(button, icons.check)
  } catch {
    // No clipboard here (a page not served over https or from this machine): the link, to copy by hand.
    window.prompt('The link:', url)
  }
}

export function filesAction(link?: Router): EditorAction {
  let dialog: HTMLDialogElement | null = null

  function open(editor: Editor): void {
    const doc = editor.slug
    if (!doc || dialog) return
    const titleOf = () => editor.documents().find((d) => d.slug === doc)?.title || doc
    const unfolded = new Set<string>()
    let shown = ''
    let timer = 0

    const all = iconButton({ label: 'Download everything', description: 'Every file the paper has made, in one zip.', icon: icons.download, onClick: () => save(`/papers/${encodeURIComponent(doc)}.zip`, `${doc}.zip`) })
    const share = iconButton({ label: 'Copy link', description: 'Copy the link to this list, to pass on.', icon: icons.link, onClick: (button) => { void copyLink(button, `/papers/${encodeURIComponent(doc)}/`) } })
    const close = iconButton({ label: 'Close', description: 'Close the files.', icon: icons.close, onClick: () => d.close() })
    const body = h('div', { class: 'gw-body df-body' })
    const hint = h('span', { class: 'gw-hint' })
    // Focus starts on the title, so the dialog is announced by name and no control looks pressed before anyone acts.
    const heading = h('h2', { id: 'df-title', class: 'gw-title', tabindex: '-1', text: titleOf() })
    const d = h('dialog', { class: 'gw gw--files', 'aria-labelledby': 'df-title' },
      h('header', { class: 'df-head' },
        h('div', { class: 'df-heading' }, h('div', { class: 'gw-label', text: 'Files' }), heading),
        h('div', { class: 'df-tools' }, all, share, close)),
      body,
      h('footer', { class: 'gw-foot' }, hint))
    dialog = d
    // Opened from a link, the list can be up before the editor knows the document's title.
    const offDocuments = editor.on('documents', () => { heading.textContent = titleOf() })

    function row(item: Item): HTMLElement {
      const href = fileUrl(doc!, item.folder ? `${item.name}.zip` : item.name)
      const size = item.files.reduce((n, f) => n + f.size, 0)
      const facts = [item.detail, item.folder ? count(item.files.length) : '', bytes(size)].filter(Boolean).join(' · ')
      const kind = h('span', { class: item.folder ? 'df-kind df-kind--folder' : 'df-kind', title: item.folder ? 'Folder' : undefined })
      if (item.folder) kind.innerHTML = icons.folder
      else kind.textContent = extension(item.name) || 'FILE'
      // A file opens in a tab of its own; a folder opens here, as its list.
      const name = item.folder
        ? h('span', { class: 'df-name', text: item.label })
        : h('a', { class: 'df-name', href, target: '_blank', rel: 'noopener', text: item.label })
      const actions = h('div', { class: 'df-actions' })
      const li = h('li', { class: 'df-row', 'data-path': item.name }, kind, h('div', { class: 'df-main' }, name, h('span', { class: 'df-detail', text: facts })), actions)
      if (item.folder) {
        const sub = h('ul', { class: 'df-sub', 'aria-label': `In ${item.label}` })
        const fill = () => sub.replaceChildren(...item.files.map((file) => {
          const url = fileUrl(doc!, file.path)
          return h('li', {},
            h('a', { href: url, target: '_blank', rel: 'noopener', text: file.path.slice(item.name.length + 1) }),
            h('span', { class: 'df-size', text: bytes(file.size) }),
            iconButton({ label: 'Copy link', description: `Copy the link to ${file.path}, to pass on.`, icon: icons.link, onClick: (button) => { void copyLink(button, url) } }))
        }))
        const unfold = iconButton({
          label: unfolded.has(item.name) ? `Hide the files in ${item.label}` : `Show the files in ${item.label}`,
          icon: unfolded.has(item.name) ? icons.chevronUp : icons.chevronDown,
          className: 'df-unfold',
          onClick: (button) => {
            const on = !unfolded.has(item.name)
            if (on) { unfolded.add(item.name); fill() } else unfolded.delete(item.name)
            sub.hidden = !on
            button.innerHTML = on ? icons.chevronUp : icons.chevronDown
            button.setAttribute('aria-label', `${on ? 'Hide' : 'Show'} the files in ${item.label}`)
            button.setAttribute('aria-expanded', String(on))
          },
        })
        unfold.setAttribute('aria-expanded', String(unfolded.has(item.name)))
        sub.hidden = !unfolded.has(item.name)
        if (!sub.hidden) fill()
        actions.append(unfold)
        li.append(sub)
      }
      actions.append(
        iconButton({ label: item.folder ? `Download ${item.label} as a zip` : `Download ${item.label}`, icon: icons.download, onClick: () => save(href, saveAs(doc!, item.folder ? `${item.name}.zip` : item.name)) }),
        iconButton({ label: 'Copy link', description: `Copy the link to ${item.label}, to pass on.`, icon: icons.link, onClick: (button) => { void copyLink(button, href) } }),
      )
      return li
    }

    function draw(listing: Listing): void {
      const items = itemsOf(listing.files)
      const total = listing.files.reduce((n, f) => n + f.size, 0)
      all.disabled = !items.length
      hint.textContent = items.length ? `${count(listing.files.length)} · ${bytes(total)} · as of ${clock(new Date())}` : `As of ${clock(new Date())}`
      // Redrawn only when the files changed, and where the person had scrolled stays put.
      const now = JSON.stringify(listing)
      if (now === shown) return
      shown = now
      const scroll = body.scrollTop
      if (!items.length) {
        body.replaceChildren(h('p', { class: 'gw-empty', text: listing.paper
          ? 'Nothing yet. The paper\'s files appear here as it is typeset.'
          : 'This document has no paper yet. Write one from it with the paper button, and what it makes appears here.' }))
        return
      }
      body.replaceChildren(...GROUPS.flatMap(([group, heading]) => {
        const rows = items.filter((item) => item.group === group)
        return rows.length ? [h('section', { class: 'df-group' }, h('h3', { class: 'gw-label', text: heading }), h('ul', { class: 'df-list' }, ...rows.map(row)))] : []
      }))
      body.scrollTop = scroll
    }

    async function load(): Promise<void> {
      try {
        const response = await fetch(`/api/galley-files/${encodeURIComponent(doc!)}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        if (dialog === d) draw(await response.json() as Listing)
      } catch (error) {
        if (dialog === d && !shown) body.replaceChildren(h('p', { class: 'gw-error', role: 'alert', text: `The files could not be read: ${(error as Error).message}` }))
      }
    }

    d.addEventListener('close', () => {
      window.clearInterval(timer)
      offDocuments()
      if (dialog === d) dialog = null
      d.remove()
      link?.shown('files', false)
    })
    d.addEventListener('click', (event) => { if (event.target === d) d.close() })
    // Inside the editor, so the controls are the editor's own, tips and all.
    ;(editor.slot('top').closest<HTMLElement>('.galley') ?? document.body).append(d)
    d.showModal()
    heading.focus()
    body.append(h('p', { class: 'gw-note', text: 'Reading the files…' }))
    void load()
    timer = window.setInterval(() => { void load() }, REFRESH_MS)
    link?.shown('files', true)
  }

  link?.view('files', { set: (on, editor) => { if (on) open(editor); else dialog?.close() } })

  return {
    id: 'files',
    label: 'Files',
    description: 'Everything the paper has made: the PDF, the Word and LaTeX versions, its references, evidence and records. Open, download or copy a link to any of them.',
    icon: icons.archive,
    run(editor) {
      if (dialog) dialog.close()
      else open(editor)
    },
  }
}
