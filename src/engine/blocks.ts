// Parts of the paper the system prints from its records, not from a section's
// words: the literature review's protocol, the data and code availability
// statement. Such a part can carry what its records were written for (a
// screening agent's instructions, a search's working log), and no author owns
// its words. When a reading of the typeset paper finds one printed wrongly,
// the author family writes it again from the same records, another family
// checks it against them, and that text prints for as long as the records are
// the same.
import { createHash } from 'node:crypto'
import type { Paper } from './paper.js'

export interface PrintedBlock {
  id: string
  /** What the part is, as a reader of the paper would name it. */
  label: string
  /** The text the system prints for it. */
  text: string
  /** The records it is written from. */
  source: unknown
}

export const sourceDigest = (source: unknown) => createHash('sha256').update(JSON.stringify(source ?? null)).digest('hex').slice(0, 16)

/** The text a part prints: the author's, once written again from the same records; otherwise the system's own. */
export function blockText(paper: Paper, block: PrintedBlock): string {
  const kept = paper.state.blocks?.[block.id]
  return kept && kept.source === sourceDigest(block.source) ? kept.text : block.text
}
