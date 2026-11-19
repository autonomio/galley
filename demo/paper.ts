// A host action: the open document is a seed, and galley writes the paper.
// The button opens the paper wizard (seed, materials, settings, start); on a
// seed that already has a paper, it shows where that paper stands.
import { icons, type EditorAction } from '../src/index.js'
import { openPaperStatus, openPaperWizard } from './wizard.js'

export function writePaperAction(): EditorAction {
  return {
    id: 'write-paper',
    label: 'Write a paper from this document',
    description: 'Use this document as the seed of a paper: add your materials and settings, then galley researches, writes, reviews and typesets it. On a seed that already has a paper, it shows where that paper stands.',
    icon: icons.play,
    async run(editor) {
      const slug = editor.slug
      if (!slug) return
      const existing = await fetch(`/api/galley-papers/${encodeURIComponent(slug)}`)
      if (existing.ok) {
        openPaperStatus(slug, (manuscript) => { void editor.open(manuscript) })
        return
      }
      const text = editor.text().trim()
      if (text.split(/\s+/).length < 40) {
        editor.notify({ source: 'paper', level: 'attention', message: 'Write a little more first: a paragraph or two of what you want to say.' })
        return
      }
      const title = text.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim().slice(0, 80) || slug
      openPaperWizard({ slug, title, text })
    },
  }
}
