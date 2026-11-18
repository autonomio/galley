// 14×14 stroke icons, one weight, so a row of them reads evenly. Hosts can
// pass their own SVG markup to custom actions.
const svg = (body: string) =>
  `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">${body}</svg>`

export const icons = {
  plus: svg('<path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
  trash: svg('<path d="M3 4h8M5.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4l.5 7a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l.5-7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  copy: svg('<rect x="3" y="3" width="7" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 3V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'),
  import: svg('<path d="M7 9V2.5M4.5 5L7 2.5 9.5 5M2.5 8.5V11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  download: svg('<path d="M7 2.5V9M4.5 6.5L7 9l2.5-2.5M2.5 8.5V11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  check: svg('<path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
  // Arrows to the corners: "expand to fill" entering writer mode, "contract
  // back" leaving it.
  focusEnter: svg('<path d="M2 5V2h3M9 2h3v3M2 9v3h3M9 12h3V9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  focusExit: svg('<path d="M5 2v3H2M9 5h3V2M5 12V9H2M9 9v3h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  comment: svg('<path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 11.5 4v4a1.5 1.5 0 0 1-1.5 1.5H6.5L4 12V9.5a1.5 1.5 0 0 1-1.5-1.5V4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'),
  chat: svg('<path d="M2 3.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 12 3.5v5A1.5 1.5 0 0 1 10.5 10H6l-2.5 2V10A1.5 1.5 0 0 1 2 8.5v-5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M4.5 5h5M4.5 7h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'),
  close: svg('<path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'),
} as const
