// What several behaviors need: readable views of the state for prompts, and
// the few state changes that more than one behavior makes.
import type { Paper } from '../paper.js'
import { fillPlaceholders, productionRecord } from '../record.js'
import { systemBlock } from '../self.js'
import { materialsBlock, measurementsBlock } from '../materials.js'
import { simulationsBlock } from '../simulations.js'
import { literatureBlock } from '../literature.js'
import { softwareBlock } from '../software.js'
import { authorYear, citationKey } from '../text.js'
import type { Citation, Claim, ClaimStatus, Family, Seat, Work } from '../types.js'

export const now = () => new Date().toISOString()

export const live = (paper: Paper) => !paper.state.outcome || paper.state.outcome === 'ready_for_submission'

export function seatFamily(paper: Paper, seat: Exclude<Seat, 'referee' | 'adjudicator'>): Family {
  return paper.config.seats[seat]
}

export function claim(paper: Paper, id: string): Claim | undefined {
  return paper.state.claims.find((c) => c.id === id)
}

export function activeClaims(paper: Paper): Claim[] {
  return paper.state.claims.filter((c) => c.status !== 'dropped')
}

export function setClaim(paper: Paper, c: Claim, status: ClaimStatus, behavior: string, reason: string, text?: string): void {
  const before = `${c.status}: ${c.text}`
  c.status = status
  if (text && text.trim() && text.trim() !== c.text) c.text = text.trim()
  c.history.push({ at: now(), behavior, from: before, to: `${c.status}: ${c.text}`, reason })
}

export function nextClaimId(paper: Paper): string {
  const n = Math.max(0, ...paper.state.claims.map((c) => Number(c.id.slice(1)) || 0)) + 1
  return `C${n}`
}

export function keyFor(paper: Paper, work: Work): string {
  if (!work.bibKey) {
    const taken = new Set(Object.values(paper.state.works).map((w) => w.bibKey).filter(Boolean) as string[])
    work.bibKey = citationKey(work, taken)
  }
  return work.bibKey
}

export function verifiedCitations(paper: Paper, claimId: string): Citation[] {
  return paper.state.citations.filter((c) => c.claimId === claimId && c.status === 'verified')
}

export function describeClaim(paper: Paper, c: Claim): string {
  const cites = verifiedCitations(paper, c.id).map((cite) => {
    const work = paper.state.works[cite.workId]
    return `    [@${keyFor(paper, work)}] ${authorYear(work)}, "${work.title}"${work.venue ? `, ${work.venue}` : ''}. Passage: "${cite.passage}"`
  })
  const support = c.status === 'supported' || c.status === 'narrowed'
    ? `evidence:\n${cites.join('\n')}`
    : c.status === 'internal' ? 'evidence: the authors\' own work; state it plainly as a property of what this paper presents; do not cite'
      : c.status === 'assumed' ? 'evidence: none needed (common knowledge or a stated premise)'
        : 'evidence: none verified; present it only as a hypothesis, an expectation or an open question, or leave it out if the section works without it'
  const review = c.origin === 'review' ? `, finding of the systematic review, uncertainty ${c.uncertainty ?? 'moderate'}` : ''
  return `- ${c.id} [${c.kind}${c.loadBearing ? ', load-bearing' : ''}${review}] ${c.text}\n  ${support}${c.softwareEvidence?.length ? `\n  Software evaluation evidence: ${c.softwareEvidence.join(', ')}.` : ''}`
}

export function claimsBlock(paper: Paper, ids?: string[]): string {
  const list = ids ? ids.map((id) => claim(paper, id)).filter((c): c is Claim => !!c && c.status !== 'dropped') : activeClaims(paper)
  return list.map((c) => describeClaim(paper, c)).join('\n')
}

export function briefBlock(paper: Paper): string {
  const { brief, plan, selectedDirection, directions } = paper.state
  const lines = [
    brief ? `Concern: ${brief.concern}\nContribution (as the seed states it): ${brief.contribution}\nObject type: ${brief.objectType}\nHost field: ${brief.field}\nAudience: ${brief.audience}` : '',
    plan ? `Thesis: ${plan.thesis}\nWorking title: ${plan.workingTitle}\nThe paper's noun: ${plan.noun}` : '',
  ]
  const chosen = selectedDirection && directions.find((d) => d.id === selectedDirection.id)
  if (chosen) lines.push(`Selected direction: ${chosen.title}: ${chosen.question} (shift: ${chosen.shift})`)
  // A paper that is a systematic review carries the review's protocol into every prompt.
  const review = paper.config.literatureReview === 'load-bearing' ? literatureBlock(paper) : ''
  const subject = paper.state.softwareSubject
  const extra = [materialsBlock(paper), measurementsBlock(paper), subject && softwareBlock(subject, paper.state.softwareEvaluation), review, simulationsBlock(paper), systemBlock(paper)].filter(Boolean)
  return [lines.filter(Boolean).join('\n'), ...extra].join('\n\n')
}

export function sectionText(paper: Paper, sectionId: string): string {
  return paper.state.passages[sectionId]?.text ?? ''
}

/** The manuscript as the referees and the frame read it: sections tagged with their ids. */
export function manuscriptBlock(paper: Paper, withAbstract = true, withLedger = true): string {
  const parts: string[] = []
  const { frame, outline } = paper.state
  // Production numbers are shown as they stand now, never as raw placeholders.
  const record = productionRecord(paper)
  if (frame && withAbstract) parts.push(`TITLE: ${paper.config.title || frame.title}\n\nABSTRACT: ${fillPlaceholders(frame.abstract, record).text}`)
  for (const section of outline?.sections ?? []) {
    parts.push(`[${section.id}] # ${section.title}\n\n${fillPlaceholders(sectionText(paper, section.id), record).text}`)
  }
  if (outline && withLedger && paper.config.ledgerAppendix !== false) parts.push(`[Appendix A, generated from the claim ledger at typesetting: it changes when claims change, and is not edited directly] # Claim ledger\n\n${fillPlaceholders(ledgerAppendix(paper), record).text}`)
  return parts.join('\n\n')
}

const STATUS_WORDS: Record<string, string> = {
  supported: 'supported', narrowed: 'narrowed to its evidence', internal: "the authors' own work", assumed: 'premise',
  unsupported: 'hypothesis: no verified evidence', open: 'open',
}

/** The claim ledger as an appendix: every claim of the final argument, its kind, its standing and its evidence. */
export function ledgerAppendix(paper: Paper): string {
  const lines = activeClaims(paper).map((c) => {
    const keys = verifiedCitations(paper, c.id).map((cite) => `@${keyFor(paper, paper.state.works[cite.workId])}`)
    const evidence = keys.length ? ` [${keys.join('; ')}]` : ''
    return `- **${c.id}** (${c.kind}${c.loadBearing ? ', load-bearing' : ''}; ${STATUS_WORDS[c.status] ?? c.status}${c.origin === 'review' ? `; from the systematic review, uncertainty ${c.uncertainty ?? 'moderate'}` : c.origin === 'system' ? '; added by the system' : '; from the seed'})${evidence}. ${c.text}`
  })
  return `Every claim of the final argument, as the claim ledger holds it: its kind, its standing, where it came from, and the verified sources it rests on. Identifiers are the ledger's own and need not be consecutive.\n\n${lines.join('\n')}`
}

/** For prompts that edit stored text: what each placeholder in it stands for right now. */
export function placeholderLegend(paper: Paper, text: string): string {
  const keys = [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((m) => m[1]))]
  if (!keys.length) return ''
  const record = productionRecord(paper)
  return `Text like {{run.calls}} is a placeholder for a number from this manuscript's own production record; it is filled in wherever the paper is shown and typeset. Keep placeholders as they are in edits. Current values: ${keys.map((k) => `{{${k}}} = ${record[k] ?? 'not recorded'}`).join('; ')}.`
}

export function referencesBlock(paper: Paper): string {
  const cited = paper.state.citations.filter((c) => c.status === 'verified')
  const seen = new Set<string>()
  const lines: string[] = []
  for (const cite of cited) {
    const work = paper.state.works[cite.workId]
    const key = keyFor(paper, work)
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(`@${key}: ${authorYear(work)}. ${work.title}.${work.venue ? ` ${work.venue}.` : ''}`)
  }
  return lines.join('\n')
}

export function citationEvidenceBlock(paper: Paper): string {
  return paper.state.citations.filter((c) => c.status === 'verified').map((cite) => {
    const work = paper.state.works[cite.workId]
    const c = claim(paper, cite.claimId)
    return `[@${keyFor(paper, work)}] supports ${cite.claimId} ("${c?.text ?? ''}") with the passage: "${cite.passage}"`
  }).join('\n')
}
