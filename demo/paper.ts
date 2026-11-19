// A host action: the open document is a seed, and galley writes the paper.
// Write or paste a rant, press the button, and the manuscript arrives in the
// document list as its own document, with a note on every referee finding.
// Pressing it again on the same seed reports where the paper stands.
import { icons, type EditorAction } from '../src/index.js'

export function writePaperAction(): EditorAction {
  return {
    id: 'write-paper',
    label: 'Write a paper from this document',
    icon: icons.chat,
    async run(editor) {
      const slug = editor.slug
      if (!slug) return
      const existing = await fetch(`/api/galley-papers/${encodeURIComponent(slug)}`)
      if (existing.ok) {
        const { status } = await existing.json()
        editor.notify({ source: 'paper', message: status })
        return
      }
      const text = editor.text().trim()
      if (text.split(/\s+/).length < 40) {
        editor.notify({ source: 'paper', level: 'attention', message: 'Write a little more first: a paragraph or two of what you want to say.' })
        return
      }
      // Fully automatic by default; on request, the load-bearing claims wait for you to pick their sources.
      const choose = window.confirm('Pick the sources for the load-bearing claims yourself? (Cancel lets galley pick every source.)')
      const response = await fetch(`/api/galley-papers/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, citations: choose ? 'mixed' : 'auto' }),
      })
      editor.notify(response.ok
        ? { source: 'paper', message: `Writing the paper. It appears here as "${slug}-paper" when it is typeset, usually within two hours. Press again to see where it stands.` }
        : { source: 'paper', level: 'error', message: `The paper could not start: ${await response.text()}` })
    },
  }
}
