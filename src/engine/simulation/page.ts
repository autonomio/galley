// The page of a reproduction package. It reruns each published simulation in the browser with the
// engine that produced the paper's numbers, compares every number with what the paper cites, and
// lets a reader change an input, or the whole spec, and run it again. It is bundled with the engine
// into one self-contained index.html: no network, nothing to install, and it opens from disk.
import { citable } from './cite.js'
import { simulate } from './core.js'
import type { SimulationSpec } from './types.js'
import { compare, type Expected } from './verify.js'

export interface PageRun {
  id: string
  title: string
  purpose: string
  assumptions: { name: string; basis: string }[]
  spec: SimulationSpec
  expected: Expected
}

export interface PageData {
  title: string
  runs: PageRun[]
}

type Make = (tag: string, attrs?: Record<string, string>, ...children: (Node | string)[]) => HTMLElement

/** Builds the page inside root and runs every simulation once. */
export function mount(root: HTMLElement, data: PageData): void {
  const doc = root.ownerDocument
  const h: Make = (tag, attrs = {}, ...children) => {
    const node = doc.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    node.append(...children)
    return node
  }
  root.append(
    h('h1', {}, data.title),
    h('p', { class: 'lead' }, 'Each simulation below runs here, in your browser, with the engine that produced the paper’s numbers, and every number is compared with what the paper cites. Change an input, or the whole spec, and run it again.'),
  )
  const runs = data.runs.map((run) => card(h, run))
  for (const run of runs) root.append(run.node)
  // One after another, so the page paints before the first run and stays responsive between runs.
  const next = (i: number) => { if (i < runs.length) setTimeout(() => { runs[i].go(); next(i + 1) }, 30) }
  next(0)
}

function card(h: Make, run: PageRun): { node: HTMLElement; go: () => void } {
  const published = JSON.stringify(run.spec, null, 2)
  const editor = h('textarea', { spellcheck: 'false', rows: '16', 'aria-label': `The spec of ${run.id}` }) as HTMLTextAreaElement
  editor.value = published
  const status = h('p', { class: 'status', role: 'status' })
  const results = h('div', { class: 'results' })
  const basis = new Map(run.assumptions.map((a) => [a.name, a.basis]))
  const parse = (): SimulationSpec | null => { try { return JSON.parse(editor.value) as SimulationSpec } catch { return null } }

  // Each field edits the input of its name, wherever the whole spec now lists it; after every run the
  // fields show what the spec holds, and a field whose input is gone is disabled.
  const fields = run.spec.inputs.map((input) => {
    const field = h('input', { type: 'text', spellcheck: 'false', 'aria-label': `${input.name} in ${run.id}` }) as HTMLInputElement
    field.value = input.dist
    field.addEventListener('change', () => {
      const spec = parse()
      const target = Array.isArray(spec?.inputs) ? spec.inputs.find((x) => x?.name === input.name) : undefined
      if (!spec || !target) {
        status.className = 'status bad'
        status.textContent = spec ? `The spec no longer has an input called ${input.name}; change it in the whole spec.` : 'The spec is not JSON; fix it in the whole spec first.'
        return
      }
      target.dist = field.value
      editor.value = JSON.stringify(spec, null, 2)
      go()
    })
    const why = basis.get(input.name)
    return { name: input.name, field, label: h('label', {}, h('span', { class: 'name' }, input.name), field, ...(why ? [h('small', {}, why)] : [])) }
  })
  const sync = (spec: unknown) => {
    const inputs = (spec as { inputs?: unknown })?.inputs
    for (const f of fields) {
      const x = Array.isArray(inputs) ? (inputs as { name?: unknown; dist?: unknown }[]).find((i) => i?.name === f.name) : undefined
      f.field.disabled = !x
      if (x) f.field.value = String(x.dist ?? '')
    }
  }

  function go() {
    status.className = 'status'
    status.textContent = 'Running…'
    // Let “Running…” paint before a long run.
    setTimeout(() => {
      let spec: unknown
      try {
        spec = JSON.parse(editor.value)
      } catch (error) {
        status.className = 'status bad'
        status.textContent = `The spec is not JSON: ${(error as Error).message}`
        return
      }
      sync(spec)
      const out = simulate(spec)
      if (!out.ok) {
        status.className = 'status bad'
        status.textContent = 'This spec cannot run:'
        results.replaceChildren(h('ul', { class: 'problems' }, ...out.problems.map((p) => h('li', {}, h('code', {}, p.at || 'spec'), ` ${p.message}`))))
        return
      }
      const c = compare(run.expected, out.result)
      const total = run.expected.numbers.length
      const ms = `${out.result.provenance.runtimeMs} ms`
      if (c.ok) {
        status.className = 'status good'
        status.textContent = `Matches the paper: all ${total} numbers (${ms}).`
      } else if (!c.same) {
        status.className = 'status changed'
        status.textContent = `This is not the paper’s spec, so these numbers are its own; ${c.matched} of ${total} still agree with the paper (${ms}).`
      } else {
        status.className = 'status bad'
        status.textContent = `${c.differences.length} of ${total} numbers differ from the paper (${ms}).`
      }
      const now = new Map(citable(out.result).map((x) => [x.key, x.value]))
      const differ = new Set(c.differences.map((d) => d.key))
      results.replaceChildren(h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Placeholder'), h('th', { class: 'num' }, 'Paper'), h('th', { class: 'num' }, 'This run'), h('th', {}, 'Meaning'))),
        h('tbody', {}, ...run.expected.numbers.map((n) => h('tr', differ.has(n.key) ? { class: 'differs' } : {},
          h('td', {}, h('code', {}, `{{${n.key}}}`)),
          h('td', { class: 'num' }, n.value),
          h('td', { class: 'num' }, now.get(n.key) ?? '—'),
          h('td', {}, n.meaning)))),
      ))
    }, 20)
  }

  const reset = () => {
    editor.value = published
    go()
  }
  const button = (label: string, action: () => void, primary = false) => {
    const b = h('button', { type: 'button', ...(primary ? { class: 'primary' } : {}) }, label)
    b.addEventListener('click', action)
    return b
  }
  const node = h('section', {},
    h('h2', {}, `${run.id} · ${run.title}`),
    h('p', {}, run.purpose),
    ...(fields.length ? [h('div', { class: 'inputs' }, ...fields.map((f) => f.label))] : []),
    h('details', {}, h('summary', {}, 'The whole spec'), editor),
    h('div', { class: 'actions' }, button('Run', go, true), button('Back to the paper’s spec', reset)),
    status,
    results,
  )
  return { node, go }
}
