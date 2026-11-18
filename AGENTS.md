# Working on Galley

Galley is a markdown editor meant to be adopted by any web app, Poise first. Read README.md for the API and the module map.

## Commands

- `npm run dev`: the demo at http://localhost:5174, documents in `.galley-data/`.
- `npm run check`: type check, unit tests, build. Run it before every commit.
- `npm run test:e2e`: Playwright against the demo. Run it after any change to `src/surface` or `src/editor`.

## Rules

- Module boundaries hold (`tests/unit/boundaries.test.ts`). Only `src/server` touches Node. `src/core` and `src/markdown` stay pure. The server never imports the browser half.
- The markdown grammar lives only in `src/markdown/syntax.ts`. The surface decides how to draw it, never what it is.
- A line's `textContent` is the saved source. Never remove or reorder characters for display; hide markers with CSS.
- An edit that crosses a line boundary goes through `replaceSourceRange`, never the browser's native merge.
- Every edit is undoable as one step. An edit made through `execCommand` fires no `beforeinput`, so wrap it in `asOneStep`.
- Storage goes through a `DocumentStore`. A new store passes `tests/unit/store-contract.test.ts` (add it to `STORES`).
- CSS reads only `--galley-*` tokens. Raw values live in `src/styles/tokens.css`.
- Host-specific features (chat, publishing, reviews) are toolbar actions, selection actions or plugins, never code in `src/editor`.
- Comments say why, not what. Many of the surface's comments record a browser behaviour that broke something; keep them with the code they explain.
- Every change ships with a test: unit tests for logic, an end-to-end test for anything a writer does.
