// A document's title is its first non-empty line, rendered as plain text.
//
// The title is a label: in the document picker, the window, a list. It
// should read the way the line reads on the page, so the markup that
// produces that rendering is stripped rather than shown: a doc whose first
// line is `**Portfolio** is the entirety` titles as `Portfolio is the
// entirety`, not `**Portfolio **is the…`.
//
// Kept deliberately literal: this mirrors the small inline grammar the
// editor itself renders (bold, italic, inline code, links, block markers)
// and nothing more. Truncated at 200 chars so titles can't dominate a list.

export const UNTITLED = 'Untitled'

export function deriveTitle(content: string): string {
  const line = (content || '').split('\n').find((l) => l.trim().length > 0)
  if (!line) return UNTITLED
  const t = stripMarkdownForTitle(line).slice(0, 200)
  return t || UNTITLED
}

// Strip the markers the editor hides when it renders a line. Order
// matters: block markers are anchored to the start, so they go first.
export function stripMarkdownForTitle(line: string): string {
  let t = String(line || '').trim()
  // Block markers: heading hashes, bullet, or an ordered-list number.
  t = t.replace(/^#{1,6}\s+/, '')
  t = t.replace(/^(?:-\s+|\d+[.)]\s+)/, '')
  // Fenced-code markers carry no prose; drop the fence and any language.
  t = t.replace(/^```+\s*\S*\s*/, '')
  // Inline runs in one left-to-right pass, the way the editor parses
  // them: a code span matches whole, so markup inside backticks is
  // never unwrapped. Alternation order is precedence — bold before
  // italic so `**x**` isn't consumed one asterisk at a time. Italic
  // keeps the editor's own rules (word edges both sides, no space
  // inside the delimiters), so arithmetic and identifiers stay
  // literal, and the link URL stops at the first `)`, as the
  // editor's parser does. Whitespace that sat inside a delimiter
  // (`**Portfolio **`) is preserved as the space it renders as, then
  // collapsed below.
  t = t.replace(
    /`([^`]+)`|\*\*([^*]+)\*\*|(?<!\w)\*(\S|\S.*?\S)\*(?!\w)|(?<!\w)_(\S|\S.*?\S)_(?!\w)|\[([^\]]+)\]\(\S+?\)/g,
    (_match, code, bold, star, underscore, link) => code ?? bold ?? star ?? underscore ?? link,
  )
  // Any delimiters left over are unmatched, so they render literally in
  // the editor too — leave them alone rather than guess.
  return t.replace(/\s+/g, ' ').trim()
}
