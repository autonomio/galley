// A host action: the open document is a seed, and galley makes a thesis or a paper from it.
// The button opens the wizard, whose first step asks which; on a seed that already has a
// project, it shows where that project stands. Either window is a view of its own
// (view=paper), so a link can open it.
import { icons, type Editor, type EditorAction } from '../src/index.js'
import type { Router } from './route.js'
import { openPaperStatus, openPaperWizard } from './wizard.js'

// The engine writes the paper's document within a moment of starting; open it once it exists.
async function openWhenWritten(editor: Editor, paper: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await editor.refresh()
    if (editor.documents().some((d) => d.slug === paper)) { await editor.open(paper); return }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  editor.notify({ source: 'paper', level: 'attention', message: `The paper has started, but its document is not there yet. Open “${paper}” from your documents in a moment.` })
}

export function writePaperAction(link?: Router): EditorAction {
  let dialog: HTMLDialogElement | null = null
  const opened = (d: HTMLDialogElement) => {
    dialog = d
    link?.shown('paper', true)
    d.addEventListener('close', () => {
      if (dialog === d) dialog = null
      link?.shown('paper', false)
    })
  }

  // A second start while the first still asks whether there is a project (a double click, a link and a click) is the same start.
  let starting: Promise<void> | null = null
  function start(editor: Editor): Promise<void> {
    starting ??= begin(editor).finally(() => { starting = null })
    return starting
  }

  async function begin(editor: Editor): Promise<void> {
    const slug = editor.slug
    if (!slug || dialog) return
    // Only a document with no project yet starts one; any other answer leads to the project's status and settings.
    const existing = await fetch(`/api/galley-papers/${encodeURIComponent(slug)}`)
    if (existing.status !== 404) {
      opened(openPaperStatus(slug, (manuscript) => { void editor.open(manuscript) }))
      return
    }
    const text = editor.text().trim()
    if (text.split(/\s+/).length < 40) {
      editor.notify({ source: 'paper', level: 'attention', message: 'Write a little more first: a paragraph or two of what you want to say.' })
      return
    }
    const title = text.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim().slice(0, 80) || slug
    opened(openPaperWizard({ slug, title, text, onStart: (paper) => { void openWhenWritten(editor, paper) } }))
  }

  link?.view('paper', {
    set: (on, editor) => {
      if (!on) { dialog?.close(); return }
      // A link to a window that does not open (a seed still too short) leaves the link as it is on screen.
      if (!dialog) void start(editor).then(() => { if (!dialog) link.shown('paper', false) })
    },
  })

  return {
    id: 'write-paper',
    label: 'Make a thesis or a paper from this document',
    description: 'Use this document as the seed of a thesis or a paper. A thesis is formulated against what the literature holds, in the direction you choose, and comes back as a brief; a paper is researched, written, reviewed and typeset. On a seed that already has a project, it shows where it stands.',
    icon: icons.play,
    run: (editor) => start(editor),
  }
}
