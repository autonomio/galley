// The referee loop: referees from families other than the author's read the
// whole manuscript; the author answers each material finding; the referee who
// raised it verifies the answer; a third family settles what stays disputed.
// Minor findings are fixed in place by whoever saw them, with no thread.
import { thirdFamily } from '../config.js'
import type { Paper } from '../paper.js'
import { HOUSE, STYLE } from '../prompts.js'
import type { Behavior, Target } from '../scheduler.js'
import { arr, enm, nobj, nstr, obj, str } from '../schema.js'
import { applyExact, dropUnknownCitations, sameClaim } from '../text.js'
import type { Disposition, Family, Finding } from '../types.js'
import { fillPlaceholders, productionRecord } from '../record.js'
import { activeClaims, briefBlock, citationEvidenceBlock, claimsBlock, keyFor, live, manuscriptBlock, nextClaimId, now, placeholderLegend, seatFamily, sectionText } from './common.js'
import { setPassage } from './write.js'

const families: Family[] = ['claude', 'gpt', 'gemini']

/** Referee seats for a round. Families rotate between rounds and never include the author's. */
export function refereesFor(paper: Paper, round: number): { seat: string; family: Family; brief: string }[] {
  const author = paper.config.seats.author
  const others = families.filter((f) => f !== author)
  return paper.config.referees.map((ref, i) => {
    let family = ref.family === author ? others[i % others.length] : ref.family
    if (round > 1 && others.length > 1) family = others[(others.indexOf(family) + round - 1) % others.length]
    return { ...ref, family }
  })
}

/** Settled means answered and, for a material finding, the answer judged by the referee who raised it. */
export const resolved = (f: Finding) => f.status !== 'open' && (f.severity === 'minor' || !f.dispositions.length || !!f.dispositions[f.dispositions.length - 1].verification || f.status === 'adjudicated' || f.status === 'noted')
const material = (f: Finding) => f.severity !== 'minor'

function knownKeys(paper: Paper): Set<string> {
  return new Set(paper.state.citations.filter((c) => c.status === 'verified').map((c) => keyFor(paper, paper.state.works[c.workId])))
}

/** Apply an exact edit wherever in the manuscript its old text is unique. */
function applyAnywhere(paper: Paper, edit: { old: string; new: string }, preferred: string | null, by: { family: Family; seat: string; behavior: string }, reason: string): boolean {
  const sections = paper.state.outline?.sections ?? []
  const order = preferred ? [preferred, ...sections.map((s) => s.id).filter((id) => id !== preferred)] : sections.map((s) => s.id)
  for (const id of order) {
    const text = sectionText(paper, id)
    const changed = applyExact(text, edit)
    if (changed === null) continue
    const { text: clean } = dropUnknownCitations(changed, knownKeys(paper))
    setPassage(paper, id, clean, { kind: 'agent', family: by.family, model: paper.config.models[by.family]?.model ?? by.family, seat: by.seat as any, behavior: by.behavior }, reason)
    return true
  }
  if (paper.state.frame && edit.old && paper.state.frame.abstract.includes(edit.old)) {
    paper.state.frame.abstract = paper.state.frame.abstract.replace(edit.old, edit.new)
    return true
  }
  return false
}

export const referee: Behavior = {
  id: 'referee', stage: 'referees', improver: true, title: 'Review edition',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.frame) return []
    const round = s.round + 1
    if (round > paper.config.rounds) return []
    if (s.findings.some((f) => !resolved(f) && f.assignee !== 'humans')) return []
    if (round > 1 && !s.findings.some((f) => f.round === round - 1 && material(f))) return []
    return refereesFor(paper, round).map((ref): Target => ({
      key: `referee:r${round}:${ref.seat}`, label: `round ${round}, ${ref.seat} (${ref.family})`,
      run: async () => {
        const previous = s.findings.filter((f) => f.round < round && material(f)).map((f) => `- [${f.seat}] ${f.question} → ${f.status}${f.dispositions.length ? `: ${f.dispositions[f.dispositions.length - 1].text}` : ''}`).join('\n')
        const reply = await paper.ask<any>({
          behavior: 'referee', target: `r${round}:${ref.seat}`, seat: `referee:${ref.seat}`, family: ref.family,
          prompt: `${HOUSE}

${ref.brief}

Review this manuscript for ${paper.config.venue}. Report findings, most severe first, at most 12.
- severity: minor (wording or small clarity issue), material (a reader would be misled, or the argument has a gap), critical (a load-bearing claim is wrong or unsupported).
- section_id: the [S…] section the finding is in, or null if it concerns the whole paper.
- quote: exact text from the manuscript the finding is about, copied character for character (at most 40 words), or an empty string for whole-paper findings.
- question: what is wrong or missing. alternatives: what else could be true or done. evidence: what in the manuscript or its cited passages shows it; never invent sources. decision: what should change.
- edit: when the fix is local, the exact replacement { old (copied from the manuscript, unique), new }; else null.
Also give verdict (accept, minor_revision, major_revision, reject) and a two-sentence summary. Do not report a finding just to have one.
Numbers about this manuscript's own production are filled in from its final record when it is typeset; never ask for them to be qualified as provisional or interim. A sentence that narrates how the manuscript is being produced, describes what happens if a step of a system fails or is skipped, or comments on the text itself instead of stating the work is a material finding: ask for it to be cut.
${previous ? `\nEarlier rounds raised these, and they were resolved as shown; do not repeat them unless the resolution is wrong:\n${previous}` : ''}

${briefBlock(paper)}

MANUSCRIPT:
${manuscriptBlock(paper)}

WHAT EACH CITATION RESTS ON:
${citationEvidenceBlock(paper) || '(no citations)'}`,
          schema: obj({
            verdict: enm(['accept', 'minor_revision', 'major_revision', 'reject']), summary: str(),
            findings: arr(obj({ severity: enm(['minor', 'material', 'critical']), section_id: nstr(), quote: str(), question: str(), alternatives: str(), evidence: str(), decision: str(), edit: nobj({ old: str(), new: str() }) })),
          }),
        })
        const sections = new Set(s.outline?.sections.map((sec) => sec.id))
        let n = s.findings.filter((f) => f.round === round && f.seat === ref.seat).length
        for (const raw of (reply.findings ?? []).slice(0, 12)) {
          const finding: Finding = {
            id: `F${round}-${ref.seat}-${++n}`, round, seat: ref.seat, family: ref.family, model: paper.config.models[ref.family]?.model ?? ref.family,
            severity: raw.severity, sectionId: raw.section_id && sections.has(raw.section_id) ? raw.section_id : null,
            quote: raw.quote ?? '', question: raw.question, alternatives: raw.alternatives, evidence: raw.evidence, decision: raw.decision,
            edit: raw.edit && raw.edit.old ? raw.edit : null, status: 'open', assignee: 'agents', origin: 'agent', dispositions: [],
          }
          if (finding.severity === 'minor') {
            const applied = finding.edit && applyAnywhere(paper, finding.edit, finding.sectionId, { family: ref.family, seat: `referee:${ref.seat}`, behavior: 'referee' }, `minor fix from ${finding.id}`)
            finding.status = applied ? 'applied' : 'noted'
          }
          s.findings.push(finding)
        }
        paper.journal({ event: 'review', round, seat: ref.seat, family: ref.family, verdict: reply.verdict, summary: reply.summary })
        paper.save()
      },
    }))
  },
}

export const closeRound: Behavior = {
  id: 'close-round', stage: 'referees', improver: true, title: 'Close round',
  ready: (paper) => {
    const s = paper.state
    const round = s.round + 1
    if (!live(paper) || round > paper.config.rounds) return []
    const seats = refereesFor(paper, round).map((r) => `referee:r${round}:${r.seat}`)
    if (!seats.every((key) => paper.isSettled(key))) return []
    return [{ key: `close-round:r${round}`, label: `round ${round}`, run: async () => { s.round = round; paper.save() } }]
  },
}

function lastDisposition(f: Finding): Disposition | undefined {
  return f.dispositions[f.dispositions.length - 1]
}

function needsResponse(paper: Paper, f: Finding): boolean {
  if (f.status !== 'open' || !material(f) || f.assignee === 'humans') return false
  const last = lastDisposition(f)
  return f.dispositions.length < paper.config.fixAttempts && (!last || last.verification?.outcome === 'disagrees')
}

export const respond: Behavior = {
  id: 'respond', stage: 'referees', improver: true, title: 'Respond to thread',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper)) return []
    const open = s.findings.filter((f) => needsResponse(paper, f))
    const groups = new Map<string, Finding[]>()
    for (const f of open) groups.set(f.sectionId ?? 'paper', [...(groups.get(f.sectionId ?? 'paper') ?? []), f])
    return [...groups.entries()].map(([sectionId, findings]): Target => ({
      key: `respond:${findings.map((f) => `${f.id}.${f.dispositions.length}`).join(',')}`, label: `${findings.length} finding(s) in ${sectionId}`,
      run: async () => {
        const family = seatFamily(paper, 'author')
        const section = s.outline?.sections.find((sec) => sec.id === sectionId)
        const text = section ? `Section ${section.id} ${section.title}:\n"""\n${sectionText(paper, section.id)}\n"""` : `The whole manuscript:\n${manuscriptBlock(paper)}`
        const reply = await paper.ask<any>({
          behavior: 'respond', target: findings.map((f) => f.id).join(','), seat: 'author', family,
          prompt: `${HOUSE}

${STYLE}

You are the author. Referees from other model families raised the findings below. Answer each one.
- fixed: the referee is right; give the edits that fix it.
- rebutted: the referee is wrong; give the concrete reason in reply, and no edits.
- limitation: the point is fair but cannot be fixed within this paper; give an edit that states it as a limitation where it belongs. State a limitation once, in the limitations section, and about the work itself ("the rubric has not been validated as a predictor of impact"), never about how this manuscript was produced or what happens if a step fails, and never as a remark on what this text does not document; if the paper already states it, point to that place in reply and give no edit.
- needs_evidence: fixing it needs evidence this paper does not cite yet (for example prior work the referee names). Give evidence_claim: the self-contained claim that evidence would support, so the system can search for it and verify it; you will answer again once it has. Give no edits.
Edits are exact replacements { old, new }: old is copied character for character from the current text and is unique; new is the replacement. Keep citations in [@key] form and use only keys already present. Add no new factual claims.
Never weaken the thesis to satisfy a referee: if a finding would require that, rebut it or state it as a limitation.
When a finding asks for a fact that the material in this request gives (a system description, the claims and their evidence, the production record), answer it fixed: state the fact in the text instead of conceding a gap.
Keep the paper's length: the section has a budget of about ${section?.words ?? 600} words. Prefer replacing a sentence to adding one, cut what a fix makes redundant, and add new text only where the finding requires it.

${briefBlock(paper)}

${text}
${placeholderLegend(paper, text)}

Claims and evidence that may be stated:
${claimsBlock(paper, section?.claimIds) || '(see manuscript)'}

FINDINGS:
${findings.map((f) => `${f.id} [${f.severity}, ${f.seat} referee]\n  quote: "${f.quote}"\n  question: ${f.question}\n  decision asked for: ${f.decision}${f.edit ? `\n  suggested edit: "${f.edit.old}" → "${f.edit.new}"` : ''}${f.dispositions.map((d) => `\n  your earlier answer (${d.kind}): ${d.text}\n  referee's verdict: ${d.verification?.outcome}: ${d.verification?.reason}`).join('')}`).join('\n\n')}`,
          schema: obj({ answers: arr(obj({ finding_id: str(), kind: enm(['fixed', 'rebutted', 'limitation', 'needs_evidence']), reply: str(), edits: arr(obj({ old: str(), new: str() })), evidence_claim: nstr() })) }),
        })
        for (const answer of reply.answers ?? []) {
          const f = findings.find((x) => x.id === answer.finding_id)
          if (!f) continue
          if (paper.config.dial === 'propose' || f.assignee === 'both' || (paper.config.dial === 'assisted' && f.severity === 'critical')) {
            // The person is in charge: the change waits for their Accept in the editor.
            const proposals = (paper.state.proposals ??= [])
            for (const edit of answer.edits ?? []) {
              if (!edit.old) continue
              proposals.push({ id: `P${proposals.length + 1}`, findingId: f.id, description: `${answer.kind}: ${answer.reply}`, old: edit.old, new: edit.new, by: family, state: 'pending' })
            }
            f.dispositions.push({ at: now(), kind: answer.kind, text: answer.reply, edits: [], family })
            f.assignee = 'humans'
            continue
          }
          if (answer.kind === 'needs_evidence' && answer.evidence_claim && f.dispositions.length + 1 < paper.config.fixAttempts) {
            // The evidence the answer needs goes through search and verification like any claim; the author answers again with it.
            const wanted = String(answer.evidence_claim).trim()
            // Evidence already asked for, by this finding or another, is searched for once.
            const asked = activeClaims(paper).find((k) => sameClaim(k.text, wanted))
            const c = asked ?? { id: nextClaimId(paper), text: wanted, kind: 'background' as const, seedQuote: '', origin: 'system' as const, need: 'external' as const, loadBearing: false, dependsOn: [], status: 'open' as const, history: [{ at: now(), behavior: 'respond', from: '', to: wanted, reason: `evidence asked for by ${f.id}` }] }
            if (!asked) paper.state.claims.push(c)
            const home = paper.state.outline?.sections.find((sec) => sec.id === f.sectionId) ?? paper.state.outline?.sections[1]
            if (home && !home.claimIds.includes(c.id)) home.claimIds.push(c.id)
            f.dispositions.push({ at: now(), kind: 'needs_evidence', text: answer.reply, edits: [], family, verification: { outcome: 'disagrees', reason: `waiting for evidence for ${c.id}`, family } })
            f.status = 'open'
            continue
          }
          const applied = (answer.edits ?? []).filter((edit: { old: string; new: string }) => applyAnywhere(paper, edit, f.sectionId, { family, seat: 'author', behavior: 'respond' }, `answer to ${f.id}`))
          const kind = answer.kind === 'needs_evidence' ? 'limitation' : answer.kind
          f.dispositions.push({ at: now(), kind: answer.kind, text: answer.reply, edits: applied, family })
          f.status = (answer.edits?.length && !applied.length && kind !== 'rebutted') ? 'open' : kind
          if (f.status === 'open') f.dispositions[f.dispositions.length - 1].verification = { outcome: 'disagrees', reason: 'none of the edits matched the current text', family }
        }
        paper.save()
      },
      skip: () => {
        for (const f of findings) {
          if (f.status !== 'open') continue
          f.status = 'noted'
          paper.state.notes.push({ at: now(), behavior: 'respond', text: `${f.id} (${f.question}) could not be answered by the author and is left for you.`, forHuman: true })
        }
      },
    }))
  },
}

export const verifyDisposition: Behavior = {
  id: 'verify-disposition', stage: 'referees', improver: true, title: 'Verify disposition',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper)) return []
    const pending = s.findings.filter((f) => ['fixed', 'rebutted', 'limitation'].includes(f.status) && lastDisposition(f) && !lastDisposition(f)!.verification)
    const byFamily = new Map<Family, Finding[]>()
    for (const f of pending) byFamily.set(f.family, [...(byFamily.get(f.family) ?? []), f])
    return [...byFamily.entries()].map(([family, findings]): Target => ({
      key: `verify-disposition:${findings.map((f) => `${f.id}.${f.dispositions.length}`).join(',')}`, label: `${findings.length} answer(s) for ${family}`,
      run: async () => {
        const reply = await paper.ask<any>({
          behavior: 'verify-disposition', target: findings.map((f) => f.id).join(','), seat: 'referee', family,
          prompt: `${HOUSE}

You raised these findings as a referee. The author answered each. Judge each answer against the current text.
- verified: the answer resolves the finding (the fix works, the rebuttal is right, or the limitation is stated adequately).
- disagrees: it does not; say exactly what is still wrong.
- uncertain: you cannot tell from the text.

${[...new Set(findings.map((f) => f.sectionId ?? 'paper'))].map((id) => id === 'paper'
  ? `CURRENT MANUSCRIPT:\n${manuscriptBlock(paper)}`
  : `CURRENT TEXT OF ${id}:\n\"\"\"\n${fillPlaceholders(sectionText(paper, id), productionRecord(paper)).text}\n\"\"\"`).join('\n\n')}

${findings.map((f) => {
  const d = lastDisposition(f)!
  return `${f.id} [${f.severity}, in ${f.sectionId ?? 'the whole paper'}]\n  your finding: ${f.question} Decision asked for: ${f.decision}\n  quote: "${f.quote}"\n  author's answer (${d.kind}): ${d.text}\n  edits made: ${d.edits.map((e) => `"${e.old}" → "${e.new}"`).join('; ') || 'none'}`
}).join('\n\n')}`,
          schema: obj({ verdicts: arr(obj({ finding_id: str(), outcome: enm(['verified', 'disagrees', 'uncertain']), reason: str() })) }),
        })
        for (const verdict of reply.verdicts ?? []) {
          const f = findings.find((x) => x.id === verdict.finding_id)
          if (!f) continue
          lastDisposition(f)!.verification = { outcome: verdict.outcome, reason: verdict.reason, family }
          if (verdict.outcome === 'disagrees') f.status = 'open'
        }
        // An answer the referee did not judge is treated as unverified, not as accepted.
        for (const f of findings) if (!lastDisposition(f)!.verification) lastDisposition(f)!.verification = { outcome: 'uncertain', reason: 'not judged', family }
        paper.save()
      },
      skip: () => {
        for (const f of findings) if (!lastDisposition(f)!.verification) lastDisposition(f)!.verification = { outcome: 'uncertain', reason: 'verification could not run', family }
      },
    }))
  },
}

export const adjudicate: Behavior = {
  id: 'adjudicate', stage: 'referees', improver: true, title: 'Adjudicate',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper)) return []
    const stuck = s.findings.filter((f) => f.status === 'open' && material(f) && f.dispositions.length >= paper.config.fixAttempts && f.assignee !== 'humans')
    return stuck.map((f): Target => {
      const family = thirdFamily(paper.config.seats.author, f.family)
      return {
        key: `adjudicate:${f.id}`, label: `${f.id} by ${family}`,
        run: async () => {
          // The whole manuscript: a disputed finding often spans sections.
          const current = manuscriptBlock(paper)
          const reply = await paper.ask<any>({
            behavior: 'adjudicate', target: f.id, seat: 'adjudicator', family,
            prompt: `${HOUSE}

${STYLE}

An author and a referee from two other model families could not agree. Decide.
- adopt_referee: the referee is right; give the edits that implement the referee's decision.
- adopt_author: the author's last answer stands; no edits.
- narrow: both are partly right; give edits that narrow the text to the common ground.
- limitation: state the disagreement as a limitation of the paper; give that edit.
Edits are exact replacements { old, new } with old copied character for character from the current text.

Finding ${f.id} [${f.severity}, ${f.seat} referee]: ${f.question}
Decision asked for: ${f.decision}
Quote: "${f.quote}"
${f.dispositions.map((d, i) => `Round ${i + 1}: author (${d.kind}): ${d.text}\n  referee: ${d.verification?.outcome}: ${d.verification?.reason}`).join('\n')}

The finding is in ${f.sectionId ?? 'the whole paper'}. The current manuscript:
"""
${current}
"""
${placeholderLegend(paper, current)}`,
            schema: obj({ decision: enm(['adopt_referee', 'adopt_author', 'narrow', 'limitation']), reason: str(), edits: arr(obj({ old: str(), new: str() })) }),
          })
          const applied = (reply.edits ?? []).filter((edit: { old: string; new: string }) => applyAnywhere(paper, edit, f.sectionId, { family, seat: 'adjudicator', behavior: 'adjudicate' }, `adjudication of ${f.id}`))
          f.adjudication = { decision: `${reply.decision}: ${reply.reason}`, family, edits: applied }
          f.status = 'adjudicated'
          paper.note('adjudicate', `${f.id} (${f.question}) was settled by ${family}: ${reply.decision}. ${reply.reason}`, true)
          paper.save()
        },
        skip: () => { f.status = 'noted' },
      }
    })
  },
}
