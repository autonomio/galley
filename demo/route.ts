// Everything on screen has a link of its own. ?doc=<name> is the document, and
// view= the views open with it, joined by '+': activity, writer, paper, files,
// choices, proposals. Opening another document is a step that Back and Forward
// walk through; opening or closing a view changes the link in place. The
// host's own parameters (store, theme) stay in the link as they were.
import type { Editor } from '../src/index.js'

export const VIEWS = ['activity', 'writer', 'paper', 'files', 'choices', 'proposals'] as const
export type ViewName = (typeof VIEWS)[number]

export interface Route {
  doc: string | null
  views: ViewName[]
}

const NAME = /^[a-z0-9][a-z0-9-]*$/i
// Views that stay open from one document to the next; the others belong to the document they were opened on.
const FOLLOW: readonly ViewName[] = ['activity', 'writer']

const isView = (value: string): value is ViewName => (VIEWS as readonly string[]).includes(value)
// Each view once, always in the same order, so one screen has one link.
const tidy = (views: readonly string[]): ViewName[] => VIEWS.filter((view) => views.includes(view))

/** What a link names: its document and the views open with it. Anything it does not know is left out. */
export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search)
  const doc = params.get('doc')
  return { doc: doc && NAME.test(doc) ? doc : null, views: tidy((params.get('view') ?? '').split(/[\s,]+/).filter(isView)) }
}

/** The query for a route, the link's other parameters kept as they were. */
export function routeSearch(route: Route, search = ''): string {
  const params = new URLSearchParams()
  if (route.doc) params.set('doc', route.doc)
  const views = tidy(route.views)
  if (views.length) params.set('view', views.join(' '))
  for (const [key, value] of new URLSearchParams(search)) if (key !== 'doc' && key !== 'view') params.append(key, value)
  const query = params.toString()
  return query ? `?${query}` : ''
}

/** Where another document leads: the views that follow the writer stay open, the rest close. */
export function nextDocument(route: Route, doc: string): Route {
  return { doc, views: route.views.filter((view) => FOLLOW.includes(view)) }
}

export interface LinkedView {
  /** Open or close it, because the link says so. */
  set(on: boolean, editor: Editor): void
}

export interface Router {
  /** What the link says now. */
  route(): Route
  /** A view the link opens and closes. */
  view(name: ViewName, view: LinkedView): void
  /** A view opened or closed by hand: the link follows, in place. */
  shown(name: ViewName, on: boolean): void
  /** From here on the link follows the editor, and the editor the link. */
  attach(editor: Editor): void
}

export function createRouter(): Router {
  const views = new Map<ViewName, LinkedView>()
  let route = parseRoute(location.search)
  let editor: Editor | null = null
  let started = false
  // A document opening because the link asked for it (the first one, Back, Forward) adds no step.
  let asked: string | null = null

  function write(next: Route, push: boolean): void {
    route = { doc: next.doc, views: tidy(next.views) }
    const now = `${location.pathname}${location.search}${location.hash}`
    const url = `${location.pathname}${routeSearch(route, location.search)}${location.hash}`
    if (url !== now) history[push ? 'pushState' : 'replaceState'](history.state, '', url)
  }

  function apply(): void {
    if (!editor) return
    for (const [name, view] of views) view.set(route.views.includes(name), editor)
  }

  function opened(slug: string): void {
    if (!editor) return
    if (!started) {
      started = true
      if (route.doc && route.doc !== slug) editor.notify({ source: 'link', level: 'attention', message: `There is no document “${route.doc}” here, so the link opened “${slug}”.` })
      write({ doc: slug, views: route.views }, false)
      // The views the link names open once their document is there.
      apply()
      return
    }
    if (asked === slug || route.doc === slug) { asked = null; return }
    // Another document, chosen by hand: a step of its own.
    const next = nextDocument(route, slug)
    const closing = route.views.filter((view) => !next.views.includes(view))
    write(next, true)
    for (const name of closing) views.get(name)?.set(false, editor)
  }

  return {
    route: () => route,
    view(name, view) { views.set(name, view) },
    shown(name, on) {
      if (route.views.includes(name) === on) return
      write({ doc: route.doc, views: on ? [...route.views, name] : route.views.filter((view) => view !== name) }, false)
    },
    attach(ed) {
      editor = ed
      ed.on('open', ({ slug }) => opened(slug))
      window.addEventListener('popstate', () => {
        route = parseRoute(location.search)
        if (route.doc && route.doc !== ed.slug) {
          asked = route.doc
          void ed.open(route.doc).then(apply)
        } else apply()
      })
    },
  }
}
