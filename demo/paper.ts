// A host action: the open document is a seed, and galley writes the paper.
// The button opens the paper wizard (seed, materials, settings, start); on a
// seed that already has a paper, it shows where that paper stands.
import { icons, type Editor, type EditorAction } from '../src/index.js'
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

export function writePaperAction(): EditorAction {
  return {
    id: 'write-paper',
    label: 'Write a paper from this document',
    description: 'Use this document as the seed of a paper: add your materials and settings, then galley researches, writes, reviews and typesets it. On a seed that already has a paper, it shows where that paper stands.',
    icon: icons.play,
    async run(editor) {
      const slug = editor.slug
      if (!slug) return
      // Only a document with no project yet starts one; any other answer leads to the project's status and settings.
      const existing = await fetch(`/api/galley-papers/${encodeURIComponent(slug)}`)
      if (existing.status !== 404) {
        openPaperStatus(slug, (manuscript) => { void editor.open(manuscript) })
        return
      }
      const text = editor.text().trim()
      if (text.split(/\s+/).length < 40) {
        editor.notify({ source: 'paper', level: 'attention', message: 'Write a little more first: a paragraph or two of what you want to say.' })
        return
      }
      const title = text.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim().slice(0, 80) || slug
      openPaperWizard({ slug, title, text, onStart: (paper) => { void openWhenWritten(editor, paper) } })
    },
  }
}
