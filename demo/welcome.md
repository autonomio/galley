# Welcome to Galley

Galley is a calm place to write **markdown**. It is drawn as you type, and every marker stays in the text, so what is saved is exactly what you wrote.

## Try it

- Type `# ` at the start of a line for a heading, `- ` for a list, `> ` for a quote.
- Select a few words, then press the comment button in the margin to leave a note.
- ⌘B makes text bold. ⌘Z and ⌘⇧Z undo and redo, and survive a reload.
- Write a row like `| Name | Role |` and press Enter to start a table. Tab moves between cells.

| Piece | Where it lives |
| --- | --- |
| Writing surface | src/surface |
| Saving and versions | src/editor/session.ts |
| Files on disk | src/server/file-store.ts |

> Every document is a plain `.md` file in a folder, so git, Dropbox or anything else you already use works with it.

---

Open the picker at the top right to switch documents, or press ⌘N for a new one.
