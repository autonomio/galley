// A host action for papers started from a seed document: "for this claim,
// choose a, b or c". Each waiting claim shows its candidate sources with the
// passage each would rest on; picking one records it, and once every choice is
// answered the paper carries on by itself. "Let galley pick" and "No source"
// are always there too.
import { icons, type Editor, type EditorAction } from '../src/index.js'
import type { Router } from './route.js'

interface Option { letter: string, passage: string, fit: string, role: string, title: string, year: number | null, authors: string[] }
interface Choice { claimId: string, claim: string, options: Option[] }

const url = (slug: string) => `/api/galley-papers/${encodeURIComponent(slug)}/choices`

/** `link` puts the panel in the address bar (view=choices), so a link can open it. */
export function choicesAction(link?: Router): EditorAction {
  let panel: HTMLElement | null = null
  const close = () => {
    if (!panel) return
    panel.remove()
    panel = null
    link?.shown('choices', false)
  }
  link?.view('choices', { set: (on, editor) => { if (on) void open(editor); else close() } })

  async function open(editor: Editor): Promise<void> {
    const slug = editor.slug
    if (!slug || panel) return
    panel = document.createElement('div')
    panel.className = 'demo-proposals'
    document.body.append(panel)
    const render = async () => {
      if (!panel) return
      // A failed read still draws the panel, Close and all, or it would stay open with no way to shut it.
      const response = await fetch(url(slug)).catch(() => null)
      const choices: Choice[] = response?.ok ? await response.json().then((b) => b.choices ?? [], () => []) : []
      if (!panel) return
      panel.replaceChildren()
      const head = document.createElement('div')
      head.className = 'demo-proposals-head'
      head.textContent = !response ? 'The choices could not be read' : response.ok ? (choices.length ? `${choices.length} claim${choices.length === 1 ? '' : 's'} waiting for your choice` : 'No citation choices waiting') : 'No paper from this document yet'
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
    link?.shown('choices', true)
    await render()
  }

  return {
    id: 'citation-choices',
    label: 'Citation choices',
    description: 'Claims waiting for you to pick their source among a, b and c, when you chose to pick citations yourself.',
    icon: icons.book,
    async run(editor) {
      if (panel) close()
      else await open(editor)
    },
  }
}
