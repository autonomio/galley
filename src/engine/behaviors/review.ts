// The referee loop: referees from families other than the author's read the
// whole manuscript; the author answers each material finding; the referee who
// raised it verifies the answer; a third family settles what stays disputed.
// Minor findings are fixed in place by whoever saw them, with no thread.
import { thirdFamily } from '../config.js'
import type { Paper } from '../paper.js'
import { HOUSE, STYLE } from '../prompts.js'
import type { Behavior, Target } from '../scheduler.js'
import { arr, enm, nobj, nstr, obj, str } from '../schema.js'
import { applyExact, dropUnknownCitations, sameClaim, squash } from '../text.js'
import type { Disposition, Family, Finding } from '../types.js'
import { fillPlaceholders, productionRecord } from '../record.js'
import { resolved } from '../findings.js'
import { activeClaims, briefBlock, citableKeys, citationEvidenceBlock, claimsBlock, live, manuscriptBlock, nextClaimId, now, placeholderLegend, seatFamily, sectionText } from './common.js'
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

export { resolved }
const material = (f: Finding) => f.severity !== 'minor'

/** An attempt that produced no answer still counts: the next runs at full effort, and the last goes to adjudication. */
function unanswered(f: Finding, family: Family, why: string): void {
  f.dispositions.push({ at: now(), kind: 'unanswered', text: why, edits: [], family, verification: { outcome: 'disagrees', reason: why, family } })
  f.status = 'open'
}

/** Whether a quote stands in the manuscript's current text, whatever its spacing and quote marks. */
function inText(paper: Paper, quote: string): boolean {
  const q = squash(quote)
  return !!q && (paper.state.outline?.sections ?? []).some((sec) => squash(sectionText(paper, sec.id)).includes(q))
}

/** Where a paper states its limits: a section named for them, else the discussion, else the last section before the conclusion. */
function limitsSection(paper: Paper): string | null {
  const sections = paper.state.outline?.sections ?? []
  const found = sections.find((sec) => /limit/i.test(sec.title)) ?? sections.find((sec) => /discussion/i.test(sec.title)) ?? sections.filter((sec) => !/conclu/i.test(sec.title)).at(-1) ?? sections.at(-1)
  return found?.id ?? null
}

const knownKeys = citableKeys

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
            id: `F${round}-${ref.seat}-${++n}`, at: new Date().toISOString(), round, seat: ref.seat, family: ref.family, model: paper.config.models[ref.family]?.model ?? ref.family,
            severity: raw.severity, sectionId: raw.section_id && sections.has(raw.section_id) ? raw.section_id : null,
            quote: raw.quote ?? '', question: raw.question, alternatives: raw.alternatives, evidence: raw.evidence, decision: raw.decision,
            edit: raw.edit && raw.edit.old ? raw.edit : null, status: 'open', assignee: 'agents', origin: 'agent', dispositions: [],
          }
          // A minor finding is fixed in place when its edit fits; otherwise the author answers it like any other.
          if (finding.severity === 'minor') {
            const applied = finding.edit && applyAnywhere(paper, finding.edit, finding.sectionId, { family: ref.family, seat: `referee:${ref.seat}`, behavior: 'referee' }, `minor fix from ${finding.id}`)
            if (applied) finding.status = 'applied'
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
  if (f.status !== 'open' || f.assignee === 'humans') return false
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
          // A first answer runs on lighter settings; once a referee has rejected one, the author answers at full effort.
          behavior: 'respond', light: findings.every((f) => !f.dispositions.length), target: findings.map((f) => f.id).join(','), seat: 'author', family,
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
        // A finding the reply left out is not left behind: the attempt counts, and the next one takes it up.
        const answered = new Set((reply.answers ?? []).map((a: { finding_id: string }) => a.finding_id))
        for (const f of findings) if (!answered.has(f.id) && needsResponse(paper, f)) unanswered(f, family, 'The author\'s reply gave no answer to this finding.')
        paper.save()
      },
      skip: () => {
        for (const f of findings) if (needsResponse(paper, f)) unanswered(f, seatFamily(paper, 'author'), 'The author could not answer this finding.')
      },
    }))
  },
}

export const verifyDisposition: Behavior = {
  id: 'verify-disposition', stage: 'referees', improver: true, title: 'Verify disposition',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper)) return []
    // An answer waits for its first verdict, or for a second one at full effort when the first could not tell.
    const recheck = (f: Finding) => lastDisposition(f)?.verification?.outcome === 'uncertain' && !lastDisposition(f)?.verification?.rechecked
    const pending = s.findings.filter((f) => material(f) && ['fixed', 'rebutted', 'limitation'].includes(f.status) && lastDisposition(f) && (!lastDisposition(f)!.verification || recheck(f)))
    const groups = new Map<string, Finding[]>()
    for (const f of pending) groups.set(`${f.family}|${recheck(f)}`, [...(groups.get(`${f.family}|${recheck(f)}`) ?? []), f])
    return [...groups.values()].map((findings): Target => {
      const family = findings[0].family
      const second = recheck(findings[0])
      // A verdict that still cannot tell does not settle the answer: it goes back to the author.
      const judge = (f: Finding, outcome: 'verified' | 'disagrees' | 'uncertain', reason: string) => {
        if (second && outcome === 'uncertain') {
          lastDisposition(f)!.verification = { outcome: 'disagrees', reason: `The referee could not confirm the answer: ${reason}`, family, rechecked: true }
          f.status = 'open'
          return
        }
        lastDisposition(f)!.verification = { outcome, reason, family, ...(second ? { rechecked: true } : {}) }
        if (outcome === 'disagrees') f.status = 'open'
      }
      return {
      key: `verify-disposition:${findings.map((f) => `${f.id}.${f.dispositions.length}`).join(',')}${second ? ':recheck' : ''}`, label: `${findings.length} answer(s) for ${family}${second ? ', checked again' : ''}`,
      run: async () => {
        const reply = await paper.ask<any>({
          behavior: 'verify-disposition', light: !second, target: findings.map((f) => f.id).join(','), seat: 'referee', family,
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
        const judged = new Set<string>()
        for (const verdict of reply.verdicts ?? []) {
          const f = findings.find((x) => x.id === verdict.finding_id)
          if (!f || judged.has(f.id)) continue
          judged.add(f.id)
          judge(f, verdict.outcome, verdict.reason)
        }
        // An answer the referee did not judge is unverified, not accepted.
        for (const f of findings) if (!judged.has(f.id)) judge(f, 'uncertain', 'not judged')
        paper.save()
      },
      skip: () => {
        for (const f of findings) judge(f, 'uncertain', 'verification could not run')
      },
    }
    })
  },
}

/** One disputed finding's thread, as the adjudicator reads it: the question, the quote, and every answer with its verdict. */
function thread(f: Finding): string {
  return `FINDING ${f.id} [${f.severity}, ${f.seat} referee]: ${f.question}
Decision asked for: ${f.decision}
Quote: "${f.quote}"
${f.dispositions.map((d, i) => `Round ${i + 1}: author (${d.kind}): ${d.text}${d.edits.length ? `\n  author's edits: ${d.edits.map((e) => `"${e.old}" -> "${e.new}"`).join('; ')}` : ''}\n  referee: ${d.verification?.outcome}: ${d.verification?.reason}`).join('\n')}`
}

/** Adjudication attempts that did not settle a finding in the text. */
const ADJUDICATION_TRIES = 2
const failedAdjudications = (paper: Paper, f: Finding) => paper.state.attempts[`adjudicate-failed:${f.id}`] ?? 0
function adjudicationFailed(paper: Paper, f: Finding, family: Family, why: string): void {
  paper.state.attempts[`adjudicate-failed:${f.id}`] = failedAdjudications(paper, f) + 1
  paper.journal({ event: 'adjudication-unsettled', finding: f.id, family, why })
}
const stuckFinding = (paper: Paper, f: Finding) => f.status === 'open' && f.dispositions.length >= paper.config.fixAttempts && f.assignee !== 'humans'

/**
 * Findings an author and a referee could not settle go to the third family at
 * full effort, in one call per section and family. The adjudicator reads that
 * section's current text, the claims and evidence it may state, and each
 * finding's thread; only a finding with no section is judged against the whole
 * manuscript. Every decision lands in the text: a finding the adjudicator sets
 * aside still gets the sentence that answers the reader who would raise it. A
 * decision that does not land is asked for again, and after that the paper
 * states the finding as a limitation (handleFinding).
 */
export const adjudicate: Behavior = {
  id: 'adjudicate', stage: 'referees', improver: true, title: 'Adjudicate',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper)) return []
    const stuck = s.findings.filter((f) => stuckFinding(paper, f) && failedAdjudications(paper, f) < ADJUDICATION_TRIES)
    const groups = new Map<string, { sectionId: string | null; family: Family; findings: Finding[] }>()
    for (const f of stuck) {
      const family = thirdFamily(paper.config.seats.author, f.family)
      const key = `${f.sectionId ?? 'paper'}|${family}`
      const group = groups.get(key) ?? { sectionId: f.sectionId, family, findings: [] }
      group.findings.push(f)
      groups.set(key, group)
    }
    return [...groups.values()].map(({ sectionId, family, findings }): Target => ({
      key: `adjudicate:${findings.map((f) => `${f.id}.${failedAdjudications(paper, f)}`).join(',')}`, label: `${findings.length} finding(s) in ${sectionId ?? 'the paper'} by ${family}`,
      run: async () => {
        const pending = findings.filter((f) => f.status === 'open')
        if (!pending.length) return
        const section = sectionId ? s.outline?.sections.find((sec) => sec.id === sectionId) : undefined
        const text = section ? sectionText(paper, section.id) : manuscriptBlock(paper)
        const scope = section
          ? `The findings are in section ${section.id} ${section.title}. Its current text:\n"""\n${text}\n"""\n\nClaims this section may state, with their evidence:\n${claimsBlock(paper, section.claimIds) || '(none)'}`
          : `The findings concern the whole paper. The current manuscript:\n"""\n${text}\n"""`
        const reply = await paper.ask<any>({
          behavior: 'adjudicate', target: pending.map((f) => f.id).join(','), seat: 'adjudicator', family,
          prompt: `${HOUSE}

${STYLE}

For each finding below, an author and a referee from two other model families could not agree. Decide each one on its own. Whatever you decide, the paper must answer the reader who would raise the same point, so every decision changes the text or points to where it already answers it.
- adopt_referee: the referee is right; give the edits that implement the referee's decision.
- narrow: both are partly right; give edits that narrow the text to the common ground.
- limitation: the point is fair but cannot be met within this paper; give the edit that states it as a limitation of the work, where the paper states its limits.
- set_aside: the referee's point does not hold, or lies outside what the paper claims. Give the reason, and either edits that make the text answer the point (clarify what it claims, or state its scope), or handled_by: the exact sentence of the current text that already answers it.
Edits are exact replacements { old, new } with old copied character for character from the text below.

${pending.map(thread).join('\n\n')}

${scope}
${placeholderLegend(paper, text)}

Return decisions: one for each finding, with its id.`,
          schema: obj({ decisions: arr(obj({ id: str(), decision: enm(['adopt_referee', 'narrow', 'limitation', 'set_aside']), reason: str(), edits: arr(obj({ old: str(), new: str() })), handled_by: nstr() })) }),
        })
        const decisions = new Map<string, any>((reply.decisions ?? []).map((d: any) => [String(d.id), d]))
        for (const f of pending) {
          const d = decisions.get(f.id)
          if (!d) { adjudicationFailed(paper, f, family, 'the decision left it out'); continue }
          const applied = (d.edits ?? []).filter((edit: { old: string; new: string }) => applyAnywhere(paper, edit, f.sectionId, { family, seat: 'adjudicator', behavior: 'adjudicate' }, `adjudication of ${f.id}`))
          const handledBy = d.decision === 'set_aside' && d.handled_by && inText(paper, d.handled_by) ? String(d.handled_by) : undefined
          if (!applied.length && !handledBy) { adjudicationFailed(paper, f, family, `${d.decision} did not land in the text: ${d.reason}`); continue }
          f.adjudication = { decision: `${d.decision}: ${d.reason}`, family, edits: applied, ...(d.decision === 'set_aside' ? { setAside: true } : {}), ...(handledBy ? { handledBy } : {}) }
          f.status = 'adjudicated'
          paper.note('adjudicate', `${f.id} (${f.question}) was settled by ${family}: ${d.decision}. ${d.reason}`, true)
        }
        paper.save()
      },
      skip: () => { for (const f of findings) if (f.status === 'open') adjudicationFailed(paper, f, family, 'adjudication could not run') },
    }))
  },
}

/**
 * The last step for a finding adjudication could not settle in the text: the
 * paper states it as a limitation of the work, where it states its limits. It
 * is not an improvement that may be skipped: a paper is not finished while a
 * finding stands unanswered.
 */
export const handleFinding: Behavior = {
  id: 'handle-finding', stage: 'referees', improver: false, title: 'State an unsettled finding as a limitation',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper)) return []
    return s.findings.filter((f) => stuckFinding(paper, f) && failedAdjudications(paper, f) >= ADJUDICATION_TRIES).map((f): Target => ({
      key: `handle-finding:${f.id}`, label: f.id,
      run: async () => {
        const home = limitsSection(paper)
        const section = s.outline?.sections.find((sec) => sec.id === home)
        if (!section) throw new Error('the paper has no section to state a limitation in')
        const family = seatFamily(paper, 'author')
        const text = sectionText(paper, section.id)
        const reply = await paper.ask<any>({
          behavior: 'handle-finding', target: f.id, seat: 'author', family,
          prompt: `${HOUSE}

${STYLE}

A referee raised the finding below. The author's answers did not satisfy the referee, and adjudication could not settle it in the text. The paper must still answer the reader who would raise it: write one sentence that states this limit of the work plainly, about the work itself (what it does not establish, test or cover), never about how the manuscript was produced. Give after: the exact sentence of the section below that it should follow, or an empty string to add it at the end.

${thread(f)}

Section ${section.id} ${section.title}, where the paper states its limits:
"""
${text}
"""
${placeholderLegend(paper, text)}`,
          schema: obj({ sentence: str(), after: str() }),
        })
        const sentence = String(reply.sentence ?? '').trim()
        if (!sentence) throw new Error('no limitation sentence was written')
        const after = String(reply.after ?? '').trim()
        const placed = after && text.includes(after) ? text.replace(after, `${after} ${sentence}`) : `${text.trimEnd()} ${sentence}`
        setPassage(paper, section.id, placed, { kind: 'agent', family, model: paper.config.models[family]?.model ?? family, seat: 'author', behavior: 'handle-finding' }, `limitation for ${f.id}, which adjudication could not settle`)
        f.adjudication = { decision: `limitation: stated as a limitation of the work after adjudication could not settle it in the text`, family, edits: [{ old: '', new: sentence }], fallback: true }
        f.status = 'adjudicated'
        paper.note('handle-finding', `${f.id} (${f.question}) could not be settled by adjudication; the paper now states it as a limitation: "${sentence}"`, true)
        paper.save()
      },
    }))
  },
}
