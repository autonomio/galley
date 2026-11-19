# Working on Galley

Galley is a markdown editor meant to be adopted by any web app, Poise first. Read README.md for the API and the module map.

## Commands

- `npm run dev`: the demo at http://localhost:5174, documents in `.galley-data/`.
- `npm run check`: type check, unit tests, build. Run it before every commit.
- `npm run test:e2e`: Playwright against the demo. Run it after any change to `src/surface` or `src/editor`.

## Papers (src/engine)

- A behavior is atomic: it reads the paper's state, does one thing, writes its result, and says when it is ready from the state alone. New behaviors go into the ladder in `src/engine/behaviors/index.ts`, after the rungs they depend on, and are proven on a real seed before the next one is built.
- Only the skeleton (extract, plan, outline, draft, frame, typeset, ready) may stop a paper. Every other behavior is an improver: give its targets a `skip` that says what giving up means, so nothing waits on it forever. Never add a check that blocks a paper over form.
- Each seat belongs to the family the paper's config names. When a model, CLI or account fails, report it or fix it; never route its work to another model or transport.
- Prompts never contain the authors' names or contact details; those are filled in at typesetting.
- A seed is the person's words; nothing is ever added to it. What a paper about galley says about how galley works comes from `src/engine/self.ts`, generated from the ladder, the seats and the package metadata. When a behavior changes, update its line in `DOES` there.
- Tests are minimal and clinical: pure rules in `tests/unit/engine.test.ts`, kept to about a second. Model behavior is proven by real runs, which replay from `calls/cache/`.

## Rules

- Module boundaries hold (`tests/unit/boundaries.test.ts`). Only `src/server` and `src/engine` touch Node, and the browser half never imports the engine. `src/core` and `src/markdown` stay pure. The server never imports the browser half.
- The markdown grammar lives only in `src/markdown/syntax.ts`. The surface decides how to draw it, never what it is.
- A line's `textContent` is the saved source. Never remove or reorder characters for display; hide markers with CSS.
- An edit that crosses a line boundary goes through `replaceSourceRange`, never the browser's native merge.
- Every edit is undoable as one step. An edit made through `execCommand` fires no `beforeinput`, so wrap it in `asOneStep`.
- Storage goes through a `DocumentStore`. A new store passes `tests/unit/store-contract.test.ts` (add it to `STORES`).
- CSS reads only `--galley-*` tokens. Raw values live in `src/styles/tokens.css`.
- Host-specific features (chat, publishing, reviews) are toolbar actions, selection actions or plugins, never code in `src/editor`.
- Comments say why, not what. Many of the surface's comments record a browser behaviour that broke something; keep them with the code they explain.
- Every change ships with a test: unit tests for logic, an end-to-end test for anything a writer does.
