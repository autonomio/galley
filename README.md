# Galley

A calm markdown writing surface that any web app can adopt as its own editor.

Markdown is drawn as you type and every marker stays in the text, so what is saved is exactly what was written. Documents are plain `.md` files. Notes attach to passages and follow them as the text changes. Saving is versioned: a change made somewhere else, in another tab or by an agent, is merged with yours, and where you both changed the same lines yours stands and you are told. Galley started as the Editor in [Poise](https://github.com/autonomio/poise) and keeps its look.

## Write a paper

Galley also writes papers. Give it a seed (a rant, notes, a transcribed talk) and atomic behaviors turn it into a pre-publication manuscript: models assigned in **Settings → Models** take different seats, citations are checked against verbatim passages, and referees review the draft until their findings are resolved, and the result is typeset as a PDF with LaTeX, Word, a sign-off sheet and an evidence package.

```bash
npm install && npm run build
```

```bash
node dist/engine/cli.js write my-seed.md --author "Your Name"
```

The paper opens in this editor the moment it starts and grows there while it is written: a strip shows who is working on it and what each is doing, every referee finding is a thread under its passage, and your edits, notes and replies are taken in within seconds. A paper can also rest on your own datasets and documents (private datasets never leave your machine), include a systematic literature review that Canary carries out for it (`--literature-review yes`), and rest on a Monte Carlo simulation galley runs on your machine (`--simulation yes`). See [Papers](docs/PAPERS.md) for the ladder, the seats, the outputs and the editor loop.

The first paper galley wrote introduces galley itself, from a seed of the author's own words with nothing added: `papers/galley/` (*Scope-Elastic Manuscript Compilation Narrows or Hedges Unsupported Claims Instead of Blocking Drafts*; `out/paper.pdf`, its sign-off sheet, evidence package and production journal). One untouched run took it from seed to manuscript in 2.8 hours: 121 model calls, 81 referee findings settled over two rounds, 11 citations verified against verbatim passages and 11 rejected, and 6 of 6 planted defects caught by the verifier.

## Run it locally

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5174. Documents are kept as markdown files in `.galley-data/`; set `GALLEY_DIR` to use another folder. Add `?store=local` to the URL to keep documents in the browser instead, with no server involved.

The Docker image serves the built editor and file API. Mount a volume at
`/data` for documents and notes. Run paper generation on the developer host
with the native model sessions and typesetter described in [Papers](docs/PAPERS.md).

## Adopt it in an app

```ts
import { createEditor, createHttpStore } from '@autonomio/galley'
import '@autonomio/galley/tokens.css'
import '@autonomio/galley/galley.css'

const editor = createEditor(document.querySelector('#editor')!, {
  store: createHttpStore({ baseUrl: '/api/galley' }),
})
```

The editor fills its element, so give that element a height. It brings its own toolbar, document picker, status line, notes and notices; each one is optional or replaceable.

### Stores

The editor reaches storage only through a `DocumentStore` (`src/stores/types.ts`):

| Store | Use |
| --- | --- |
| `createHttpStore({ baseUrl })` | Galley's server, or anything that speaks its protocol |
| `createLocalStore()` | No backend: documents live in `localStorage` |
| `createMemoryStore()` | Tests, demos, or a host that persists elsewhere |
| your own | Implement the interface; `tests/unit/store-contract.test.ts` states the rules |

Every store applies the same write rules (`src/core/write-guard.ts`). A write names the version it was based on and is refused when that version is no longer current. A client's older revision is acknowledged and dropped.

### Server

```ts
import http from 'node:http'
import { createFileStore, createGalleyHandler } from '@autonomio/galley/server'

const handler = createGalleyHandler({ store: createFileStore({ dir: './documents' }) })
http.createServer((req, res) => handler(req, res)).listen(3000)
```

The handler is Connect-style (`req, res, next`), so it also mounts in Express or Vite; `galleyVitePlugin({ dir })` does the Vite part. The protocol:

| Route | |
| --- | --- |
| `GET {base}/docs` | `{ docs }`, newest first |
| `POST {base}/docs` | a new blank document |
| `GET {base}/doc/:slug` | `{ slug, content, updated_at, version }` |
| `PUT {base}/doc/:slug` | `{ content, client_id, revision, base_version }` → 200, or 409 with `current_version` |
| `DELETE {base}/doc/:slug` | the document and its notes |
| `GET` / `PUT {base}/doc/:slug/annotations` | the notes, versioned the same way |

`POST` works wherever `PUT` does, because `navigator.sendBeacon` can only POST; that is how a save survives the tab closing. A write without a precondition gets 428.

Files are written atomically (temp file, fsync, rename). The default lock serializes writes within one process. When several processes write one folder, pass a cross-process `lock` to `createFileStore`.

### Extending

```ts
createEditor(el, {
  store,
  toolbar: ['writer', 'new', 'import', 'copy', publishAction, 'delete'],
  selectionActions: ['comment', createIssueAction],
  plugins: [reviewsPlugin],
  notify: (notice) => myToasts.show(notice),
  confirm: (message) => myDialog.ask(message),
})
```

- **Toolbar actions**: `{ id, label, icon, run(editor, button) }`, optionally `pressed`, `disabled`, `shortcut`, `danger`. The built-ins are the same shape, named by id.
- **Selection actions**: `{ id, label, icon, run(passage, editor) }`. The `passage` carries its source text, its range and its on-screen rect.
- **Plugins**: `(editor) => cleanup`. They use `editor.on('open' | 'change' | 'status' | 'documents' | 'layout' | 'annotations' | 'writer-mode' | 'notice', …)`, draw in `editor.layer(name)` with `editor.rects(start, end)`, and redraw on `layout`. `editor.slot('header')` is a strip under the toolbar and `editor.slot('top')` a block above the text, for the host's own content.
- **Threads**: a note can carry an `author`, `replies`, `labels` and `resolved`; its panel then shows the conversation and takes replies. `options.me` names the writer in threads.
- **Other writers**: `editor.receive(slug, content, version)` and `editor.annotations.receive(notes, version)` bring a change made elsewhere (an agent, another tab) into the open document, merged with the writer's own work and without moving the caret. A save refused because someone else wrote first merges the same way (`src/core/merge.ts`).
- **Suggested edits** (for agents): `editor.edits.highlight(edit)`, `editor.edits.accept(edit, slug)`. An edit is bound to the document it was proposed for, applied with a conflict check, and withdrawn if it cannot be saved.
- **The surface alone**: `createSurface(element, { onChange })` is the writing surface with no documents, storage or chrome.

### Theming

Galley's CSS reads only `--galley-*` custom properties (`src/styles/tokens.css`), defined on the editor root at zero specificity. Restyle it by setting tokens on `.galley`, never by overriding rules:

```css
.galley { --galley-ctl-base-size: 17px; --galley-accent: rebeccapurple; }
```

`theme: 'light'` switches the neutral stack. The fonts (IBM Plex Sans, Zen Maru Gothic, IBM Plex Mono) are the host's to load; `demo/index.html` shows how.

## How it is built

```
src/
  markdown/   the grammar (shared with any read-only renderer) and titles
  core/       pure logic: write rules, save queue, history, anchoring, edits, tables
  surface/    the contenteditable writing surface: rendering, caret, undo, gestures
  editor/     createEditor: session (persistence), notes, marks, toolbar, picker
  stores/     DocumentStore and its HTTP, memory and local implementations
  server/     file store, HTTP handler, Vite plugin (Node only)
  engine/     papers: behaviors, the scheduler, model transports, evidence, rendering (Node only)
  styles/     tokens.css and galley.css
demo/         the app `npm run dev` serves
tests/unit    Vitest: core, stores (one contract for all), protocol, session, boundaries
tests/e2e     Playwright: the editor as a writer uses it
```

These rules are enforced by `tests/unit/boundaries.test.ts`:
- Only `src/server` and `src/engine` touch Node, and the browser half never imports the engine.
- `src/core` and `src/markdown` touch neither the DOM nor Node.
- The server never imports the browser half.

`npm run check` runs the type check, the unit tests and the build. `npm run test:e2e` drives the demo in Chromium.

## Toward replacing Poise's Editor

Galley speaks Poise's wire protocol and file layout, so the swap is mostly configuration:

- **Storage**: `createHttpStore({ baseUrl: '/api/editor' })` in the browser and `createGalleyHandler({ basePath: '/api/editor' })` on the server, over `~/.poise/editor`. Pass `sidecars: ['chat.json', 'publish.json', 'google.json']` so a delete still takes Poise's side-cars, and pass Poise's `withProcessLock` as `lock`.
- **Keys**: `storagePrefix: 'poise-editor'` keeps existing undo history and the last-opened document.
- **Feedback**: `notify` routes to the notification rail; `confirm` uses Poise's own dialog.
- **Style**: a small bridge stylesheet (still to write) sets `--galley-*` from Poise's tokens, so Poise's Style panel keeps working.
- **Poise-only features become plugins and actions**: chat pane and chat session (toolbar actions), inline threads and reviews (plugins on `layout` with their own layers), publishing and Google Docs (a toolbar action, plus `setFrozen` and `adopt` for imports), issue and snippet (selection actions), agent edit cards (`editor.edits`).

### Changes from Poise's Editor

Behaviour is ported as-is, with these fixes found while extracting it:
- A selection survives its line being redrawn (e.g. the caret's arrival revealing a link's source); previously it collapsed.
- ⌘B and cut are each their own undo step. Edits made through `execCommand` fire no `beforeinput`, so before they folded into the preceding typing or were not undoable at all.
- Cut removes exactly what it copies, in source coordinates, so hidden markers on the surrounding lines survive a cut across lines.
- Escape from an empty new note returns the caret to the passage, as it does for any other note.
- Failures to create or delete a document now show a notice instead of only logging.
- A note with an empty snippet can no longer hang re-anchoring.

## License

MIT
