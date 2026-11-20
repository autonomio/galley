// 16×16 stroke icons drawn to one grid (a 1.5 stroke, round ends and joins,
// 12×12 of live area), so a row of them reads as one set. Each shows what its
// control does; a toggle shows what pressing it will do. Hosts can pass their
// own SVG markup to custom actions, and iconButton takes any of these.
const svg = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

// The tray under the arrows of import and download.
const tray = 'M2.75 9.5v2.25a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V9.5'
const bubble = 'M2.75 4.25a1.5 1.5 0 0 1 1.5-1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7.5l-3 2.5v-2.5h-.25a1.5 1.5 0 0 1-1.5-1.5z'

export const icons = {
  plus: svg('<path d="M8 3.25v9.5M3.25 8h9.5"/>'),
  trash: svg('<path d="M2.75 4.25h10.5M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25M4.25 4.25l.55 8.3a1.25 1.25 0 0 0 1.25 1.2h3.9a1.25 1.25 0 0 0 1.25-1.2l.55-8.3"/>'),
  copy: svg('<rect x="5.25" y="5.25" width="8" height="8" rx="1.5"/><path d="M10.75 2.75h-6.5a1.5 1.5 0 0 0-1.5 1.5v6.5"/>'),
  import: svg(`<path d="M8 10V2.75M5.25 5.5 8 2.75l2.75 2.75${tray}"/>`),
  download: svg(`<path d="M8 2.75V10M5.25 7.25 8 10l2.75-2.75${tray}"/>`),
  check: svg('<path d="m3.25 8.5 3 3 6.5-7"/>'),
  /** Two checks: everything seen. */
  checks: svg('<path d="m1.75 8.5 2.75 2.75 5.75-6.5M7.75 10.5l.75.75 5.75-6.5"/>'),
  // Arrows to the corners: "expand to fill" entering writer mode, "contract
  // back" leaving it.
  focusEnter: svg('<path d="M2.75 6V2.75H6M10 2.75h3.25V6M2.75 10v3.25H6M13.25 10v3.25H10"/>'),
  focusExit: svg('<path d="M6 2.75V6H2.75M10 2.75V6h3.25M2.75 10H6v3.25M13.25 10H10v3.25"/>'),
  comment: svg(`<path d="${bubble}"/>`),
  chat: svg(`<path d="${bubble}M5.5 5.75h5M5.5 8h3"/>`),
  close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  // Start: set something going that then runs by itself.
  play: svg('<path d="M5 3.4v9.2a.6.6 0 0 0 .92.5l7-4.6a.6.6 0 0 0 0-1l-7-4.6A.6.6 0 0 0 5 3.4z"/>'),
  /** Sources: a book open at its passage. */
  book: svg('<path d="M8 4.5C6.75 3.5 5.1 3 2.75 3v9c2.35 0 4 .5 5.25 1.5 1.25-1 2.9-1.5 5.25-1.5V3C10.9 3 9.25 3.5 8 4.5zM8 4.5v9"/>'),
  /** Suggested changes, as an editor marks them. */
  pencil: svg('<path d="M10.5 2.9a1.4 1.4 0 0 1 2 0l.6.6a1.4 1.4 0 0 1 0 2L6 12.6l-3.25.65.65-3.25zM9.25 4.15l2.6 2.6"/>'),
  /** Work going on: who is doing what, and what has been done. */
  activity: svg('<path d="M1.75 8h2.5L6 3.75l3.5 8.5L11.25 8h3"/>'),
  chevronDown: svg('<path d="M4.25 6.25 8 10l3.75-3.75"/>'),
  chevronUp: svg('<path d="M4.25 9.75 8 6l3.75 3.75"/>'),
  sun: svg('<circle cx="8" cy="8" r="2.75"/><path d="M8 1.75V3M8 13v1.25M1.75 8H3M13 8h1.25M3.6 3.6l.9.9M11.5 11.5l.9.9M3.6 12.4l.9-.9M11.5 4.5l.9-.9"/>'),
  moon: svg('<path d="M13.5 8.6A5.75 5.75 0 1 1 7.4 2.5a4.5 4.5 0 0 0 6.1 6.1z"/>'),
  /** Files in a folder on this computer. */
  folder: svg('<path d="M2.75 4.75a1.5 1.5 0 0 1 1.5-1.5h2.3l1.45 1.5h3.75a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-7.5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  /** Kept in this browser. */
  browser: svg('<rect x="2.25" y="3" width="11.5" height="10" rx="1.5"/><path d="M2.25 6h11.5M4.5 4.5h.01M6.25 4.5h.01"/>'),
} as const
