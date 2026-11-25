// When a referee finding counts as settled, for the review loop and for the
// production record alike.
import type { Finding } from './types.js'

/**
 * Settled: answered and, for a material finding, the answer verified by the referee who raised it, or decided by a
 * third family in the text. galley never sets a finding aside on its own: a finding left aside is settled only by
 * a person's own decision.
 */
export const resolved = (f: Finding) => {
  if (f.status === 'open') return false
  if (f.status === 'noted') return f.assignee === 'humans'
  if (f.status === 'adjudicated' || f.status === 'applied' || f.status === 'dropped' || f.severity === 'minor') return true
  return f.dispositions.at(-1)?.verification?.outcome === 'verified'
}
