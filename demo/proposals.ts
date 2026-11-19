// A host action for galley papers: the changes agents propose and wait on
// you for. Each shows its reason and its before and after; hovering lights the
// passage it changes; Accept applies it as one undoable, saved edit, Decline
// closes it. Decisions go back to the paper's next run.
import { icons, type Editor, type EditorAction, type EditProposal } from '../src/index.js'

interface Proposal extends EditProposal {
  id: string
  findingId: string
  description: string
  state: 'pending' | 'accepted' | 'declined'
}

const url = (slug: string) => `/api/galley-proposals/${encodeURIComponent(slug)}`

async function load(slug: string): Promise<Proposal[]> {
  const response = await fetch(url(slug))
  if (!response.ok) return []
  return ((await response.json()).proposals ?? []) as Proposal[]
}

async function decide(slug: string, proposal: Proposal, state: 'accepted' | 'declined'): Promise<void> {
  await fetch(url(slug), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: proposal.id, state }) })
}

function row(editor: Editor, slug: string, proposal: Proposal, onDone: () => void): HTMLElement {
  const card = document.createElement('div')
  card.className = 'demo-proposal'
  const why = document.createElement('div')
  why.className = 'demo-proposal-why'
  why.textContent = proposal.description
  const before = document.createElement('div')
  before.className = 'demo-proposal-old'
  before.textContent = proposal.old ? `− ${proposal.old}` : '(insertion)'
  const after = document.createElement('div')
  after.className = 'demo-proposal-new'
  after.textContent = proposal.new ? `+ ${proposal.new}` : '(deletion)'
  const actions = document.createElement('div')
  actions.className = 'demo-proposal-actions'
  const decline = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Decline', className: 'demo-link' })
  const accept = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Accept', className: 'demo-link' })
  actions.append(decline, accept)
  card.append(why, before, after, actions)
  card.addEventListener('mouseenter', () => editor.edits.highlight(proposal))
  card.addEventListener('mouseleave', () => editor.edits.clearHighlight())
  if (!editor.edits.locate(proposal)) {
    accept.disabled = true
    accept.textContent = 'Not found in the text'
  }
  accept.addEventListener('click', async () => {
    const outcome = await editor.edits.accept(proposal, slug)
    if (outcome !== 'applied') { accept.textContent = outcome === 'conflict' ? 'Conflict: text changed' : 'Not saved'; return }
    await decide(slug, proposal, 'accepted')
    onDone()
  })
  decline.addEventListener('click', async () => {
    await decide(slug, proposal, 'declined')
    onDone()
  })
  return card
}

export function proposalsAction(): EditorAction {
  let panel: HTMLElement | null = null
  const close = () => { panel?.remove(); panel = null }
  return {
    id: 'proposals',
    label: 'Proposed changes',
    description: 'Changes the agents propose for this paper, each with its reason and its before and after. Accept applies one; Decline closes it.',
    icon: icons.check,
    async run(editor) {
      if (panel) { close(); return }
      const slug = editor.slug
      if (!slug) return
      panel = document.createElement('div')
      panel.className = 'demo-proposals'
      document.body.append(panel)
      const render = async () => {
        if (!panel) return
        const pending = (await load(slug)).filter((p) => p.state === 'pending')
        panel.replaceChildren()
        const head = document.createElement('div')
        head.className = 'demo-proposals-head'
        head.textContent = pending.length ? `${pending.length} proposed change${pending.length === 1 ? '' : 's'}` : 'No proposed changes'
        const x = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Close', className: 'demo-link' })
        x.addEventListener('click', close)
        head.append(x)
        panel.append(head, ...pending.map((p) => row(editor, slug, p, render)))
      }
      await render()
    },
  }
}
