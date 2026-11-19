// A host action for papers started from a seed document: "for this claim,
// choose a, b or c". Each waiting claim shows its candidate sources with the
// passage each would rest on; picking one records it, and once every choice is
// answered the paper carries on by itself. "Let galley pick" and "No source"
// are always there too.
import { icons, type EditorAction } from '../src/index.js'

interface Option { letter: string, passage: string, fit: string, role: string, title: string, year: number | null, authors: string[] }
interface Choice { claimId: string, claim: string, options: Option[] }

const url = (slug: string) => `/api/galley-papers/${encodeURIComponent(slug)}/choices`

export function choicesAction(): EditorAction {
  let panel: HTMLElement | null = null
  const close = () => { panel?.remove(); panel = null }
  return {
    id: 'citation-choices',
    label: 'Citation choices',
    icon: icons.comment,
    async run(editor) {
      if (panel) { close(); return }
      const slug = editor.slug
      if (!slug) return
      panel = document.createElement('div')
      panel.className = 'demo-proposals'
      document.body.append(panel)
      const render = async () => {
        if (!panel) return
        const response = await fetch(url(slug))
        const choices: Choice[] = response.ok ? (await response.json()).choices : []
        panel.replaceChildren()
        const head = document.createElement('div')
        head.className = 'demo-proposals-head'
        head.textContent = response.ok ? (choices.length ? `${choices.length} claim${choices.length === 1 ? '' : 's'} waiting for your choice` : 'No citation choices waiting') : 'No paper from this document yet'
        const x = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Close', className: 'demo-link' })
        x.addEventListener('click', close)
        head.append(x)
        panel.append(head)
        for (const choice of choices) {
          const card = document.createElement('div')
          card.className = 'demo-proposal'
          const claim = document.createElement('div')
          claim.className = 'demo-proposal-new'
          claim.textContent = `${choice.claimId}: ${choice.claim}`
          card.append(claim)
          const answer = async (value: string) => {
            await fetch(url(slug), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claimId: choice.claimId, answer: value }) })
            await render()
          }
          for (const option of choice.options) {
            const row = document.createElement('div')
            row.className = 'demo-proposal-why'
            const pick = Object.assign(document.createElement('button'), { type: 'button', className: 'demo-link', textContent: `${option.letter})` })
            pick.addEventListener('click', () => answer(option.letter))
            const who = `${option.authors.join(', ')}${option.authors.length >= 3 ? ' et al.' : ''} (${option.year ?? 'n.d.'}). ${option.title}`
            row.append(pick, document.createTextNode(` ${who} [${option.fit}, ${option.role}]: “${option.passage}”`))
            card.append(row)
          }
          const actions = document.createElement('div')
          actions.className = 'demo-proposal-actions'
          const none = Object.assign(document.createElement('button'), { type: 'button', textContent: 'No source', className: 'demo-link' })
          const auto = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Let galley pick', className: 'demo-link' })
          none.addEventListener('click', () => answer('none'))
          auto.addEventListener('click', () => answer('auto'))
          actions.append(none, auto)
          card.append(actions)
          panel.append(card)
        }
      }
      await render()
    },
  }
}
