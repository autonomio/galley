// Closing: calibrate the checks on planted defects, profile the finished
// paper against the standard, typeset it, and mark it ready for submission.
import type { Paper } from '../paper.js'
import { BLUEPRINT, HOUSE, placeholderGuide, STYLE } from '../prompts.js'
import { contentHash, typeset as render } from '../render.js'
import type { Behavior, Target } from '../scheduler.js'
import { arr, enm, int, nstr, obj, str } from '../schema.js'
import type { Calibration, Citation } from '../types.js'
import { activeClaims, claim, live, manuscriptBlock, seatFamily, setClaim } from './common.js'
import { isNarrowing } from './truth.js'
import { toReview } from './front.js'
import { resolved } from './review.js'
import { FRAME_NUMBERS } from './write.js'

const FACTORS = ['input_not_output', 'shared_bottleneck', 'conventional_body_one_graft', 'surprising_and_certain', 'opens_more_than_closes', 'cheap_to_adopt', 'early'] as const

/** Plant defects among real citations and see whether the verifier catches them. */
export interface CalibrationItem { id: string; claim: string; cite: Citation; kind: 'mismatch' | 'overclaim' | 'control' }

/**
 * The calibration set, built from the paper's own verified citations: claims
 * paired with another claim's passage, claims inflated beyond their passage,
 * and unaltered controls. Deterministic, so a rerun asks the same questions.
 */
export function calibrationItems(verified: Citation[], textOf: (claimId: string) => string): CalibrationItem[] {
  const items: CalibrationItem[] = []
  if (verified.length < 2) return items
  const pick = (i: number) => verified[(i * 7) % verified.length]
  const add = (claimText: string, cite: Citation, kind: CalibrationItem['kind']) => items.push({ id: `P${items.length + 1}`, claim: claimText, cite, kind })
  for (let i = 0; i < 3; i++) {
    const a = pick(i)
    // A mismatch needs a passage from another work about another claim; without one, there is no mismatch to plant.
    const others = verified.filter((x) => x.claimId !== a.claimId && x.workId !== a.workId)
    const b = others.find((x) => !items.some((it) => it.cite === x)) ?? others[0]
    if (b) add(textOf(a.claimId), b, 'mismatch')
  }
  for (let i = 3; i < 6; i++) {
    const a = pick(i)
    const text = textOf(a.claimId)
    add(`It is now established beyond doubt, in every field and without exception, that ${text.charAt(0).toLowerCase()}${text.slice(1)}`, a, 'overclaim')
  }
  for (let i = 6; i < 8; i++) add(textOf(pick(i).claimId), pick(i), 'control')
  return items
}

export const calibrate: Behavior = {
  // The verifier's measured accuracy is part of every paper's record, so one bad model call never costs it.
  id: 'calibrate', stage: 'truth', improver: true, title: 'Calibrate checks', attempts: 5,
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || s.calibration || s.citations.some((c) => c.status === 'selected')) return []
    const verified = s.citations.filter((c) => c.status === 'verified')
    if (verified.length < 2 || !s.outline) return []
    return [{
      key: 'calibrate:verifier', label: 'planted defects for the verifier',
      run: async () => {
        const items = calibrationItems(verified, (id) => claim(paper, id)!.text)
        const order = [...items].sort((x, y) => (x.id.charCodeAt(1) * 31 + x.claim.length) % 11 - (y.id.charCodeAt(1) * 31 + y.claim.length) % 11)
        const family = seatFamily(paper, 'verifier')
        const reply = await paper.ask<any>({
          behavior: 'calibrate', target: 'verifier', seat: 'verifier', family,
          prompt: `${HOUSE}

You verify citations. For each item, decide whether the quoted passage from the cited work supports the claim as stated. Be strict: support means the passage itself states it, not that it is on the same topic.
- supported: the passage supports the claim as stated.
- narrower: the passage supports only a narrower or weaker claim.
- not_supported: the passage does not support the claim, or contradicts it.

${order.map((it) => {
  const work = paper.state.works[it.cite.workId]
  return `ITEM ${it.id}\n  CLAIM: ${it.claim}\n  WORK: ${work.authors.slice(0, 3).join(', ')} (${work.year ?? 'n.d.'}). ${work.title}.\n  PASSAGE: "${it.cite.passage}"`
}).join('\n\n')}`,
          schema: obj({ items: arr(obj({ id: str(), outcome: enm(['supported', 'narrower', 'not_supported']), reason: nstr() })) }),
        })
        const verdicts = new Map<string, string>((reply.items ?? []).map((x: any) => [x.id, x.outcome]))
        const details = items.map((it) => {
          const outcome = verdicts.get(it.id)
          const caught = it.kind === 'control' ? outcome === 'supported' : outcome !== undefined && outcome !== 'supported'
          return { kind: it.kind, caught, family }
        })
        const planted = details.filter((d) => d.kind !== 'control')
        const calibration: Calibration = { planted: planted.length, caught: planted.filter((d) => d.caught).length, details }
        s.calibration = calibration
        const controls = details.filter((d) => d.kind === 'control')
        paper.journal({ event: 'calibration', planted: calibration.planted, caught: calibration.caught, controls_passed: controls.filter((d) => d.caught).length, controls: controls.length })
        paper.save()
      },
    }]
  },
}

/** Whether the referee loop has nothing left to do. */
export function reviewDone(paper: Paper): boolean {
  const s = paper.state
  if (!s.frame) return false
  if (paper.config.off.includes('referee')) return true
  if (s.findings.some((f) => !resolved(f) && f.assignee !== 'humans')) return false
  if (s.round >= paper.config.rounds) return true
  return s.round >= 1 && !s.findings.some((f) => f.round === s.round && f.severity !== 'minor')
}

/**
 * Review edits the prose, never the ledger. Once review is done, a family other
 * than the author's reads the final text against every claim, so the ledger,
 * the evidence package and the sign-off sheet say what the manuscript says.
 */
export const reconcile: Behavior = {
  id: 'reconcile', stage: 'close', improver: true, title: 'Reconcile the ledger with the text',
  ready: (paper) => !live(paper) || !paper.state.outline || paper.isSettled('frame:final') || !reviewDone(paper) ? [] : [{
    key: 'reconcile:ledger', label: 'every claim against the final text',
    run: async () => {
      const claims = activeClaims(paper)
      const reply = await paper.ask<any>({
        behavior: 'reconcile', target: 'ledger', seat: 'checker', family: seatFamily(paper, 'checker'),
        prompt: `${HOUSE}

The manuscript below went through review after its claim ledger was written, and its text changed. For each claim in the ledger, say how the final text states it.
- stated: the text states it as the ledger has it, possibly in other words.
- narrowed: the text states only a narrower or weaker version of it. Give narrowed: the claim reworded to exactly what the text now states, in the claim's own terms.
- absent: the text no longer states it, not even as a hypothesis or an open question.
Give quote: the sentence of the text that states it, copied exactly (empty when absent). Judge only the sections, not the title or abstract.

LEDGER:
${claims.map((c) => `${c.id}: ${c.text}`).join('\n')}

MANUSCRIPT:
${manuscriptBlock(paper, false, false)}`,
        schema: obj({ items: arr(obj({ claim_id: str(), how: enm(['stated', 'narrowed', 'absent']), quote: str(), narrowed: nstr() })) }),
      })
      for (const item of reply.items ?? []) {
        const c = claims.find((k) => k.id === item.claim_id)
        if (!c) continue
        if (item.how === 'absent') setClaim(paper, c, 'dropped', 'reconcile', 'not stated in the final text')
        // A rewording that keeps little of the claim is a different claim: the ledger keeps the original.
        else if (item.how === 'narrowed' && item.narrowed && isNarrowing(c.text, item.narrowed)) setClaim(paper, c, c.status, 'reconcile', `the final text states it more narrowly: "${String(item.quote).slice(0, 300)}"`, item.narrowed)
      }
      paper.save()
    },
  }],
}

export const reprofile: Behavior = {
  id: 'reprofile', stage: 'close', improver: true, title: 'Re-profile impact',
  ready: (paper) => !live(paper) || paper.state.profileAfter || !reviewDone(paper) ? [] : [{
    key: 'reprofile:final', label: 'the finished paper against the standard',
    run: async () => {
      const s = paper.state
      const reply = await paper.ask<any>({
        behavior: 'reprofile', target: 'final', seat: 'challenger', family: seatFamily(paper, 'challenger'),
        prompt: `${HOUSE}

${BLUEPRINT}

Profile the finished manuscript below against the standard: score each factor from 0 to 3 with its evidence and what would still raise it, name the weakest factor, and state the ceiling. Verdict: worth_writing if it is ready to go out, reformulate if it should be reframed first, no_contribution if it has none. ${s.ideaReview ? `Before drafting, the idea scored: ${s.ideaReview.factors.map((f) => `${f.name} ${f.score}`).join(', ')}.` : ''}

MANUSCRIPT:
${manuscriptBlock(paper)}`,
        schema: obj({
          factors: arr(obj({ name: enm(FACTORS), score: int('0 to 3'), evidence: str(), improve: str() })),
          weakest: enm(FACTORS), ceiling: str(), verdict: enm(['worth_writing', 'reformulate', 'no_contribution']), summary: str(),
        }),
      })
      s.profileAfter = toReview(reply)
      paper.note('reprofile', `Final profile: ${s.profileAfter.factors.map((f) => `${f.name} ${f.score}/3`).join(', ')}. Weakest: ${s.profileAfter.weakest}. ${s.profileAfter.summary}`, true)
      paper.save()
    },
  }],
}

/** The frame behavior's second pass: after review, title, abstract and keywords are written again from the text as it now stands. */
export function finalFrame(paper: Paper): Target[] {
    const s = paper.state
    if (!live(paper) || !s.frame || s.outcome || paper.isSettled('frame:final') || !reviewDone(paper)) return []
    // The frame is rewritten from the reconciled ledger, so its numbers count what the text states.
    if (!paper.isSettled('reconcile:ledger') && !paper.config.off.includes('reconcile')) return []
    return [{
      key: 'frame:final', label: 'title, abstract and keywords from the reviewed text',
      run: async () => {
        const frame = s.frame!
        const reply = await paper.ask<any>({
          behavior: 'frame', target: 'final', seat: 'author', family: seatFamily(paper, 'author'),
          prompt: `${HOUSE}

${STYLE}

The manuscript below has been through review, and its sections changed. Rewrite its frame so it states exactly what the manuscript now states.
- title: keep the current title ("${frame.title}") unless it no longer fits the text; at most 15 words.
- abstract: 150 to 250 words, one paragraph, no citations: the problem, what the paper contributes, how the contribution is supported, and what it opens. State only what the manuscript states, with the same hedges and limits. ${FRAME_NUMBERS}
- keywords: 5 to 7.

${placeholderGuide()}

Current abstract, for reference: ${frame.abstract}

MANUSCRIPT:
${manuscriptBlock(paper, false)}`,
          schema: obj({ title: str(), abstract: str(), keywords: arr(str()) }),
        })
        s.frame = { ...frame, title: reply.title || frame.title, abstract: reply.abstract || frame.abstract, keywords: reply.keywords?.length ? reply.keywords : frame.keywords }
        paper.save()
      },
      // An improvement pass: if it cannot run, the first frame stands.
      skip: () => {},
    }]
}

export const typeset: Behavior = {
  id: 'typeset', stage: 'skeleton', improver: false, title: 'Typeset and package',
  ready: (paper) => {
    const s = paper.state
    if (!s.frame || !s.outline || !s.outline.sections.every((sec) => s.passages[sec.id])) return []
    if (s.figures.some((f) => f.status === 'planned') && !paper.config.off.includes('figure')) return []
    const hash = contentHash(paper)
    return [{
      key: `typeset:${hash}`, label: 'PDF, LaTeX, Word and the evidence package',
      run: async () => {
        const made = await render(paper)
        paper.journal({ event: 'typeset', hash, files: made })
        // Rendering can fill in references; the key stays the hash it was asked for.
        paper.settle(`typeset:${hash}`, 'done')
      },
    }]
  },
}

export const ready: Behavior = {
  id: 'ready', stage: 'close', improver: false, title: 'Mark ready for submission',
  ready: (paper) => {
    const s = paper.state
    if (s.outcome || !reviewDone(paper)) return []
    if (!(s.profileAfter || paper.isSettled('reprofile:final') || paper.config.off.includes('reprofile'))) return []
    if (!paper.isSettled('frame:final')) return []
    if (!paper.isSettled(`typeset:${contentHash(paper)}`)) return []
    return [{
      key: 'ready:paper', label: 'every gate on one revision',
      run: async () => {
        s.outcome = 'ready_for_submission'
        paper.journal({ event: 'outcome', outcome: s.outcome })
        paper.save()
      },
    }]
  },
}
