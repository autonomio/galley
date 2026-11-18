// The document as one string plus where each line starts in it: the
// coordinate space edits, highlights and review anchors are located in.
export interface TextSnapshot {
  text: string
  lineStarts: number[]
}

export function snapshotOf(lines: readonly string[]): TextSnapshot {
  const text = lines.join('\n')
  const lineStarts: number[] = [0]
  let acc = 0
  for (let i = 0; i < lines.length - 1; i++) {
    acc += lines[i].length + 1 // +1 for the '\n'
    lineStarts.push(acc)
  }
  return { text, lineStarts }
}

/** The line a character offset falls on. */
export function locateLine(lineStarts: readonly number[], charIdx: number): number {
  for (let i = lineStarts.length - 1; i >= 0; i--) {
    if (lineStarts[i] <= charIdx) return i
  }
  return 0
}

/** Words a reader would count: runs holding a letter or a digit, so markers don't count. */
export function countWords(text: string): number {
  let n = 0
  for (const word of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(word)) n++
  return n
}
