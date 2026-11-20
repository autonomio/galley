// Every external claim gets evidence from Canary's search, a verbatim passage
// from the work itself, and a verdict from a family that did not propose it.
import { createHash } from 'node:crypto'
import { canarySearch, openalexKeyed, SourceUnavailable, workFromHit, type QueryResult, type SearchHit } from '../evidence.js'
import type { Paper } from '../paper.js'
import { HOUSE } from '../prompts.js'
import type { Behavior, Target } from '../scheduler.js'
import { arr, enm, nstr, obj, str } from '../schema.js'
import { isVerbatim, overlap } from '../text.js'
import type { Candidate, Citation, Claim } from '../types.js'
import { activeClaims, claim, keyFor, live, seatFamily, setClaim } from './common.js'

const BATCH = 6
const VERIFY_BATCH = 10
const PER_CLAIM = 2
/** A narrowed claim takes at least this share of its content words from the original, or it is a different claim: narrowing removes, drifting adds. */
export const NARROWED_KEEPS = 1 / 2

/** Whether `narrowed` is the claim made smaller rather than replaced by something else. */
export const isNarrowing = (original: string, narrowed: string) => overlap(narrowed, original) >= NARROWED_KEEPS

/** Still waiting on evidence of some kind: a search, a verdict, or a person's choice. */
const needsEvidence = (c: Claim) => c.need === 'external' && c.status === 'open'

/** A claim the scholarly index had nothing for, still waiting for its look at primary sources on the web (when the paper uses them). */
export const awaitsWebSearch = (paper: Paper, c: Claim) =>
  paper.config.webSources !== false && c.need === 'external' && c.status === 'unsupported' && !paper.state.attempts[`web:${c.id}`]

function needsSearch(paper: Paper, c: Claim): boolean {
  return needsEvidence(c) && !paper.state.candidates.some((k) => k.claimId === c.id) && !paper.state.choices?.[c.id]
}

/** In choose mode every external claim waits for a person; in mixed mode only load-bearing or contested ones. */
function wantsChoice(paper: Paper, c: Claim): boolean {
  // The assisted dial makes load-bearing citations wait for the person, as mixed mode does.
  const mode = paper.config.citations === 'auto' && paper.config.dial === 'assisted' ? 'mixed' : paper.config.citations
  if (mode === 'choose') return true
  if (mode !== 'mixed') return false
  return c.loadBearing || paper.state.candidates.some((k) => k.claimId === c.id && k.role === 'contrast')
}

function askChoice(paper: Paper, c: Claim): void {
  const options = paper.state.candidates.filter((k) => k.claimId === c.id).slice(0, 6).map((k, i) => ({ ...k, letter: String.fromCharCode(97 + i) }))
  paper.state.choices = { ...(paper.state.choices ?? {}), [c.id]: { claimId: c.id, options, asked: new Date().toISOString() } }
  paper.note('find-evidence', `Choose citations for ${c.id} ("${c.text}"): galley choices ${paper.dir}`, true)
}

/** A person's answer to a choice: letters, "auto" to let the system pick, or "none" to hedge the claim. */
export function answerChoice(paper: Paper, claimId: string, answer: string): string {
  const choice = paper.state.choices?.[claimId]
  const c = claim(paper, claimId)
  if (!choice || !c) return `No open choice for ${claimId}.`
  const letters = answer.toLowerCase().split(/[\s,]+/).filter(Boolean)
  choice.answered = { letters, at: new Date().toISOString() }
  if (letters[0] === 'none') {
    setClaim(paper, c, 'unsupported', 'choose', 'the author chose no citation')
  } else if (letters[0] === 'auto') {
    if (!selectNext(paper, claimId, PER_CLAIM).length) setClaim(paper, c, 'unsupported', 'choose', 'no candidate left')
  } else {
    for (const option of choice.options.filter((o) => letters.includes(o.letter))) {
      paper.state.citations.push({ id: `K${paper.state.citations.length + 1}`, claimId, workId: option.workId, passage: option.passage, role: option.role, status: 'selected', chosenBy: 'human' })
    }
  }
  paper.save()
  return `${claimId}: ${letters.join(', ')} recorded; the next run verifies ${letters[0] === 'none' ? 'nothing' : 'the chosen passages'}.`
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 10)

/** Pick the next candidates for a claim that are not yet cited or rejected. */
function selectNext(paper: Paper, claimId: string, count: number): Citation[] {
  const used = new Set(paper.state.citations.filter((c) => c.claimId === claimId).map((c) => `${c.workId}|${c.passage}`))
  const usedWorks = new Set(paper.state.citations.filter((c) => c.claimId === claimId && c.status !== 'rejected').map((c) => c.workId))
  const order = { direct: 0, narrower: 1, indirect: 2 }
  const pool = paper.state.candidates
    .filter((c) => c.claimId === claimId && c.role !== 'contrast' && !used.has(`${c.workId}|${c.passage}`) && !usedWorks.has(c.workId))
    .sort((a, b) => order[a.fit] - order[b.fit])
  const chosen: Citation[] = []
  for (const cand of pool) {
    if (chosen.length >= count || chosen.some((c) => c.workId === cand.workId)) continue
    chosen.push({ id: `K${paper.state.citations.length + chosen.length + 1}`, claimId, workId: cand.workId, passage: cand.passage, role: cand.role, status: 'selected', chosenBy: 'auto' })
  }
  paper.state.citations.push(...chosen)
  return chosen
}

export const findEvidence: Behavior = {
  id: 'find-evidence', stage: 'truth', improver: true, title: 'Find evidence',
  ready: (paper) => {
    if (!live(paper) || !paper.state.outline) return []
    const open = activeClaims(paper).filter((c) => needsSearch(paper, c))
    return batches(open, BATCH).map((group): Target => {
      const ids = group.map((c) => c.id)
      return {
        key: `find-evidence:${ids.join(',')}`, label: `evidence for ${ids.join(', ')}`,
        run: async () => {
          const family = seatFamily(paper, 'checker')
          // A search costs the same whatever its page size: without a key's budget, one search per claim reads deeper instead of two reading shallow.
          const searches = openalexKeyed() ? 2 : 1
          const q = await paper.ask<any>({
            behavior: 'find-evidence', target: ids.join(','), seat: 'checker', family,
            prompt: `${HOUSE}

${searches === 2
  ? 'For each claim, write two literature search queries for a scholarly index (OpenAlex full-text search: plain keywords, 3 to 8 words, no boolean operators or quotes). One uses the established terms the literature itself would use for this finding; the other is more specific.'
  : 'For each claim, write one literature search query for a scholarly index (OpenAlex full-text search: plain keywords, 3 to 8 words, no boolean operators or quotes), in the established terms the literature itself would use for this finding.'} If the claim names a known study or author, include the distinctive terms of that work.

${group.map((c) => `${c.id}: ${c.text}`).join('\n')}`,
            schema: obj({ queries: arr(obj({ claim_id: str(), searches: arr(str()) })) }),
          })
          const queries: { id: string; search: string; claimId: string }[] = []
          for (const item of q.queries ?? []) {
            if (!ids.includes(item.claim_id)) continue
            for (const [n, search] of (item.searches ?? []).slice(0, searches).entries()) {
              if (search && !queries.some((x) => x.search === search)) queries.push({ id: `${item.claim_id}q${n + 1}`, search, claimId: item.claim_id })
            }
          }
          const searching = paper.begin({ behavior: 'find-evidence', target: ids.join(','), what: `Canary search, ${queries.length} queries` })
          let results: Record<string, QueryResult>
          try {
            results = await canarySearch(paper.path('canary', `evidence-${hash(ids.join(','))}`), `galley:${paper.state.slug}:${ids.join(',')}`, queries, searches === 2 ? 10 : 20, (ms, why) => { paper.journal({ event: 'source_wait', behavior: 'find-evidence', wait_ms: ms, why }); paper.say(`… find-evidence: ${why}; next try in ${Math.round(ms / 1000)}s`) }).finally(searching)
          } catch (error) {
            if (!(error instanceof SourceUnavailable)) throw error
            // The outage was waited out as long as galley waits: these claims are stated as hypotheses, and the paper goes on.
            for (const c of group) if (c.status === 'open') setClaim(paper, c, 'unsupported', 'find-evidence', `the evidence search could not run: ${error.message}`)
            paper.note('find-evidence', `Evidence for ${ids.join(', ')} could not be searched: ${error.message}`, true)
            paper.save()
            return
          }
          const perClaim = new Map<string, SearchHit[]>()
          for (const query of queries) {
            const list = perClaim.get(query.claimId) ?? []
            for (const hit of results[query.id]?.results ?? []) if (hit.abstract && !list.some((h) => h.id === hit.id)) list.push(hit)
            perClaim.set(query.claimId, list.slice(0, paper.config.candidatesPerClaim + 2))
          }
          for (const list of perClaim.values()) for (const hit of list) paper.state.works[hit.id] ??= workFromHit(hit)
          const reply = await paper.ask<any>({
            behavior: 'find-evidence', target: `${ids.join(',')}:passages`, seat: 'checker', family,
            prompt: `${HOUSE}

For each claim, read its candidate works and choose up to three whose abstracts bear on it. For each choice copy the exact passage (one or two consecutive sentences, verbatim, character for character from the abstract) that supports, qualifies or contradicts the claim. fit: direct (the passage states the claim), narrower (it states a narrower or weaker version), indirect (related but not the claim itself). role: support, contrast (contradicts or complicates), review (a synthesis that reports it), method (the source of a method or tool the claim uses), priority (the original work the claim credits). Choose nothing for a claim when no candidate bears on it; never stretch a passage.

${group.map((c) => {
  const list = perClaim.get(c.id) ?? []
  return `CLAIM ${c.id}: ${c.text}\n${list.length ? list.map((h) => `  WORK ${h.id}: ${h.authors.slice(0, 3).join(', ')}${h.authors.length > 3 ? ' et al.' : ''} (${h.year ?? 'n.d.'}). ${h.title}.${h.venue ? ` ${h.venue}.` : ''}\n  ABSTRACT: ${h.abstract.slice(0, 1800)}`).join('\n') : '  (no candidates found)'}`
}).join('\n\n')}`,
            schema: obj({ claims: arr(obj({ claim_id: str(), choices: arr(obj({ work_id: str(), passage: str(), fit: enm(['direct', 'narrower', 'indirect']), role: enm(['support', 'contrast', 'review', 'method', 'priority']), note: str() })) })) }),
          })
          let rejected = 0
          for (const item of reply.claims ?? []) {
            if (!ids.includes(item.claim_id)) continue
            for (const choice of item.choices ?? []) {
              const work = paper.state.works[choice.work_id]
              if (!work || !isVerbatim(choice.passage, work.abstract)) { rejected++; continue }
              const candidate: Candidate = { claimId: item.claim_id, workId: work.id, passage: choice.passage.trim(), fit: choice.fit, role: choice.role, note: choice.note }
              paper.state.candidates.push(candidate)
            }
          }
          if (rejected) paper.journal({ event: 'passages_not_verbatim', behavior: 'find-evidence', count: rejected })
          for (const c of group) {
            if (wantsChoice(paper, c) && paper.state.candidates.some((k) => k.claimId === c.id)) { askChoice(paper, c); continue }
            const picked = selectNext(paper, c.id, PER_CLAIM)
            if (!picked.length) setClaim(paper, c, 'unsupported', 'find-evidence', 'no candidate passage bears on the claim')
          }
          paper.save()
        },
        skip: () => {
          for (const c of group) if (c.status === 'open') setClaim(paper, c, 'unsupported', 'find-evidence', 'the evidence search could not run')
        },
      }
    })
  },
}

export const verify: Behavior = {
  id: 'verify', stage: 'truth', improver: true, title: 'Verify support',
  ready: (paper) => {
    if (!live(paper)) return []
    const pending = paper.state.citations.filter((c) => c.status === 'selected')
    return batches(pending, VERIFY_BATCH).map((group): Target => ({
      key: `verify:${group.map((c) => c.id).join(',')}`, label: `citations ${group.map((c) => c.id).join(', ')}`,
      run: async () => {
        const reply = await paper.ask<any>({
          behavior: 'verify', target: group.map((c) => c.id).join(','), seat: 'verifier', family: seatFamily(paper, 'verifier'),
          prompt: `${HOUSE}

You verify citations. For each item, decide whether the quoted passage from the cited work supports the claim as stated. Be strict: support means the passage itself states it, not that it is on the same topic.
- supported: the passage supports the claim as stated.
- narrower: the passage supports a weaker version of the same claim: the same subject and the same relation, with a smaller scope, an added qualifier or lower certainty. Give narrowed: the claim in its own terms with only the unsupported part removed or qualified, keeping its role in the argument. Never turn the claim into what the passage says about something else, and never bring in the passage's own subject, setting, terms or findings that the claim did not state.
- not_supported: the passage does not support the claim, contradicts it, or speaks to a different subject, system, population or effect than the claim does, however related.
Give a one-sentence reason for every verdict.

${group.map((cite) => {
  const work = paper.state.works[cite.workId]
  return `ITEM ${cite.id}\n  CLAIM: ${claim(paper, cite.claimId)?.text}\n  WORK: ${work.authors.slice(0, 3).join(', ')} (${work.year ?? 'n.d.'}). ${work.title}.${work.venue ? ` ${work.venue}.` : ''}\n  PASSAGE: "${cite.passage}"`
}).join('\n\n')}`,
          schema: obj({ items: arr(obj({ id: str(), outcome: enm(['supported', 'narrower', 'not_supported']), reason: str(), narrowed: nstr() })) }),
        })
        const family = seatFamily(paper, 'verifier')
        const verdicts = new Map<string, any>((reply.items ?? []).map((item: any) => [item.id, item]))
        for (const cite of group) {
          const verdict = verdicts.get(cite.id)
          const c = claim(paper, cite.claimId)
          if (!verdict || !c) continue
          // A "narrowed" claim that keeps little of the original is a different claim: the passage does not support this one.
          if (verdict.outcome === 'narrower' && verdict.narrowed && !isNarrowing(c.text, verdict.narrowed)) {
            verdict.reason = `the narrowed wording ("${verdict.narrowed}") is a different claim. ${verdict.reason}`
            verdict.outcome = 'not_supported'
            verdict.narrowed = null
          }
          cite.verdict = { outcome: verdict.outcome, reason: verdict.reason, family, ...(verdict.narrowed ? { narrowed: verdict.narrowed } : {}) }
          if (verdict.outcome === 'not_supported') {
            cite.status = 'rejected'
            continue
          }
          cite.status = 'verified'
          keyFor(paper, paper.state.works[cite.workId])
          if (verdict.outcome === 'narrower' && verdict.narrowed && c.status !== 'supported') {
            // A claim another passage supports as stated stays as stated.
            setClaim(paper, c, 'narrowed', 'verify', `narrowed to what ${cite.id} supports: ${verdict.reason}`, verdict.narrowed)
          } else if (verdict.outcome === 'supported' && (c.status === 'open' || c.status === 'unsupported')) {
            setClaim(paper, c, 'supported', 'verify', `${cite.id} supports it: ${verdict.reason}`)
          }
        }
        // Claims whose citations all failed try the next candidates, then hedge.
        for (const cite of group) {
          const c = claim(paper, cite.claimId)
          if (!c || c.status !== 'open') continue
          const pending = paper.state.citations.some((k) => k.claimId === c.id && k.status === 'selected')
          if (pending) continue
          if (!selectNext(paper, c.id, 1).length) setClaim(paper, c, 'unsupported', 'verify', 'every candidate passage failed verification')
        }
        paper.save()
      },
      skip: () => {
        // Unverified citations are never used; their claims are hedged instead.
        for (const cite of group) {
          if (cite.status !== 'selected') continue
          cite.status = 'rejected'
          cite.verdict = { outcome: 'not_supported', reason: 'verification could not run', family: seatFamily(paper, 'verifier') }
          const c = claim(paper, cite.claimId)
          if (c && c.status === 'open' && !paper.state.citations.some((k) => k.claimId === c.id && k.status === 'selected')) {
            setClaim(paper, c, 'unsupported', 'verify', 'verification could not run')
          }
        }
      },
    }))
  },
}

/** A load-bearing claim without support puts the thesis in question; the challenger decides. */
export const reassess: Behavior = {
  id: 'reassess', stage: 'truth', improver: true, title: 'Reassess thesis',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.plan) return []
    if (s.citations.some((c) => c.status === 'selected') || activeClaims(paper).some(needsEvidence)) return []
    // A claim that may still find its primary source on the web has not failed yet.
    if (activeClaims(paper).some((c) => awaitsWebSearch(paper, c))) return []
    const failed = activeClaims(paper).filter((c) => c.loadBearing && c.status === 'unsupported')
    if (!failed.length) return []
    const ids = failed.map((c) => c.id).join(',')
    return [{
      key: `reassess:${ids}`, label: `thesis without ${ids}`,
      run: async () => {
        const reply = await paper.ask<any>({
          behavior: 'reassess', target: ids, seat: 'challenger', family: seatFamily(paper, 'challenger'),
          prompt: `${HOUSE}

Load-bearing claims of this paper found no verified evidence. Decide what that means for the thesis.
- stands: the thesis holds without them as stated, because they can be stated as hypotheses, scoped, or argued from the paper's own material.
- narrowed: the thesis holds in a narrower form; give the narrowed thesis.
- fails: no honest version of the thesis survives.

Thesis: ${s.plan!.thesis}
Unsupported load-bearing claims:
${failed.map((c) => `- ${c.id}: ${c.text}`).join('\n')}
Supported claims:
${activeClaims(paper).filter((c) => c.status === 'supported' || c.status === 'narrowed' || c.status === 'internal').map((c) => `- ${c.id}: ${c.text}`).join('\n')}`,
          schema: obj({ outcome: enm(['stands', 'narrowed', 'fails']), thesis: nstr(), reason: str() }),
        })
        if (reply.outcome === 'fails') {
          s.outcome = 'thesis_not_supported'
          paper.note('reassess', `The thesis is not supported: ${reply.reason}`, true)
        } else {
          if (reply.outcome === 'narrowed' && reply.thesis) {
            paper.note('reassess', `Thesis narrowed from "${s.plan!.thesis}": ${reply.reason}`, true)
            s.plan!.thesis = reply.thesis
          }
          for (const c of failed) c.loadBearing = false
        }
        paper.save()
      },
    }]
  },
}

export { verifyCitationsSettled, selectNext, PER_CLAIM }

/** Whether a section's claims have finished their evidence work (or given up on it). */
function verifyCitationsSettled(paper: Paper, claimIds: string[]): boolean {
  const ids = new Set(claimIds)
  if (paper.state.citations.some((c) => ids.has(c.claimId) && c.status === 'selected')) return false
  return !activeClaims(paper).some((c) => ids.has(c.id) && (needsEvidence(c) || awaitsWebSearch(paper, c)))
}
