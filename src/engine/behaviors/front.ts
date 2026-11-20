// From the seed to an argument: extract what the seed claims, position it
// against the literature, challenge the idea, and plan and outline the paper.
import { canarySearch, SourceUnavailable, workFromHit, type QueryResult } from '../evidence.js'
import { BLUEPRINT, HOUSE, STYLE } from '../prompts.js'
import { REVIEW_SECTION, withReviewSection } from '../literature.js'
import type { Behavior } from '../scheduler.js'
import { arr, bool, enm, int, nstr, obj, str } from '../schema.js'
import { squash } from '../text.js'
import type { Claim, ClaimKind, Direction, EvidenceNeed, Factor, IdeaReview } from '../types.js'
import { activeClaims, briefBlock, claim, live, nextClaimId, now, seatFamily, setClaim } from './common.js'

const KINDS = ['contribution', 'background', 'method', 'novelty', 'common_knowledge'] as const
const OBJECT_TYPES = ['capability', 'coordinate_system', 'frame', 'territory', 'finding', 'other'] as const
const FACTORS = ['input_not_output', 'shared_bottleneck', 'conventional_body_one_graft', 'surprising_and_certain', 'opens_more_than_closes', 'cheap_to_adopt', 'early'] as const

const needFor = (kind: ClaimKind): EvidenceNeed => kind === 'contribution' ? 'internal' : kind === 'common_knowledge' ? 'none' : 'external'

export const extract: Behavior = {
  id: 'extract', stage: 'skeleton', improver: false, title: 'Extract claims',
  ready: (paper) => paper.state.brief || paper.state.outcome ? [] : [{
    key: 'extract:seed', label: 'the seed',
    run: async () => {
      const reply = await paper.ask<any>({
        behavior: 'extract', target: 'seed', seat: 'author', family: seatFamily(paper, 'author'),
        prompt: `${HOUSE}

Read the seed below. It may be a rant, rough notes or transcribed speech. Recover what a paper could be made of.

- has_subject: whether the seed has a subject a paper could be about at all.
- concern: the human concern behind it, in one sentence, as an interpretation and not a diagnosis.
- contribution: what the seed says the authors' work is or delivers, in one sentence.
- object_type: what kind of thing the contribution is: capability, coordinate_system (benchmark, dataset, standard, map), frame, territory, finding, or other.
- field: the host field a paper on this would be published in.
- audience: who would read and build on it.
- about_system: true only when the seed is about galley itself, the system that is producing this manuscript, or about part of it; false for any other subject.
- claims: every distinct claim the seed makes or clearly implies. Each is a short self-contained statement that keeps its conditions, quantifiers and scope. kind is contribution (what the authors' own work is or does), background (a claim about the world that others established), method (how something is done), novelty (that something is new), or common_knowledge (needs no citation). seed_quote is an exact, verbatim excerpt of the seed (at most 40 words) that the claim comes from. Do not add claims the seed does not make.

SEED:
"""
${paper.state.seed.text}
"""`,
        schema: obj({
          has_subject: bool(), concern: str(), contribution: str(), object_type: enm(OBJECT_TYPES), field: str(), audience: str(), about_system: bool(),
          claims: arr(obj({ text: str(), kind: enm(KINDS), seed_quote: str() })),
        }),
      })
      const s = paper.state
      s.brief = { hasSubject: !!reply.has_subject, concern: reply.concern, contribution: reply.contribution, objectType: reply.object_type, field: reply.field, audience: reply.audience, aboutSystem: !!reply.about_system }
      s.claims = (reply.claims ?? []).map((c: any, i: number): Claim => ({
        id: `C${i + 1}`, text: String(c.text).trim(), kind: c.kind,
        seedQuote: squash(s.seed.text).includes(squash(c.seed_quote || '')) ? c.seed_quote : '',
        origin: 'seed', need: needFor(c.kind), loadBearing: false, dependsOn: [], status: 'open', history: [],
      }))
      if (!s.brief.hasSubject || !s.claims.length) {
        s.outcome = 'no_subject'
        paper.note('extract', 'The seed has no subject a paper could be about.', true)
      }
      paper.save()
    },
  }],
}

function hitsBlock(results: Record<string, QueryResult>, queries: { id: string; search: string }[], perQuery: number): string {
  return queries.map((q) => {
    const r = results[q.id]
    if (!r) return ''
    const rows = r.results.slice(0, perQuery).map((w) => `  ${w.id} (${w.year ?? 'n.d.'}) ${w.title}${w.venue ? ` — ${w.venue}` : ''}${w.abstract ? `\n    ${w.abstract.slice(0, 500)}` : ''}`)
    return `Query "${q.search}" matched ${r.matched ?? 'unknown'} works; top results:\n${rows.join('\n')}`
  }).join('\n\n')
}

export const position: Behavior = {
  id: 'position', stage: 'aim', improver: true, title: 'Position against prior art, the bottleneck and the consensus',
  ready: (paper) => !live(paper) || !paper.state.brief?.hasSubject || paper.state.positioning.priorArt ? [] : [{
    key: 'position:seed', label: 'prior art, bottleneck and consensus',
    run: async () => {
      const family = seatFamily(paper, 'checker')
      const brief = briefBlock(paper)
      const q = await paper.ask<any>({
        behavior: 'position', target: 'queries', seat: 'checker', family,
        prompt: `${HOUSE}

Write literature search queries for a scholarly index (OpenAlex full-text search: plain keywords, 3 to 8 words, no boolean operators or quotes).
- prior_art: 3 queries that would find the closest existing work to the contribution.
- bottleneck: 2 queries that would find work describing the problem the contribution addresses.
- consensus: 2 queries that would find reviews or syntheses of what the field currently believes about the problem.

${brief}`,
        schema: obj({ prior_art: arr(str()), bottleneck: arr(str()), consensus: arr(str()) }),
      })
      const queries = [
        ...(q.prior_art ?? []).slice(0, 3).map((search: string, i: number) => ({ id: `prior${i + 1}`, search })),
        ...(q.bottleneck ?? []).slice(0, 2).map((search: string, i: number) => ({ id: `need${i + 1}`, search })),
        ...(q.consensus ?? []).slice(0, 2).map((search: string, i: number) => ({ id: `belief${i + 1}`, search })),
      ].filter((x, i, all) => x.search && all.findIndex((y) => y.search === x.search) === i)
      const searching = paper.begin({ behavior: 'position', target: 'search', what: `Canary search, ${queries.length} queries` })
      let results: Record<string, QueryResult>
      try {
        results = await canarySearch(paper.path('canary', 'position'), `galley:${paper.state.slug}:position`, queries, 12, (ms, why) => { paper.journal({ event: 'source_wait', behavior: 'position', wait_ms: ms, why }); paper.say(`… position: ${why}; next try in ${Math.round(ms / 1000)}s`) }).finally(searching)
      } catch (error) {
        if (!(error instanceof SourceUnavailable)) throw error
        // The outage was waited out as long as galley waits: the idea is reviewed without positioning rather than not at all.
        paper.note('position', `Prior art, the bottleneck and the consensus were not checked: ${error.message}`, true)
        paper.save()
        return
      }
      for (const r of Object.values(results)) for (const hit of r.results) if (hit.abstract || hit.title) paper.state.works[hit.id] ??= workFromHit(hit)
      const years: Record<string, number> = {}
      for (const r of Object.values(results)) for (const hit of r.results) if (hit.year) years[hit.year] = (years[hit.year] ?? 0) + 1
      const reply = await paper.ask<any>({
        behavior: 'position', target: 'judgement', seat: 'checker', family,
        prompt: `${HOUSE}

Position this contribution against the search results below. Use only these results.
- prior_art: verdict novel (nothing close), partly_anticipated (close work exists but differs materially) or anticipated (it has been done); closest: up to 5 work ids (W…) from the results; summary: how the contribution differs from the closest work, or that it does not.
- census: ceiling: how many people are blocked by this problem and who they are, stated with its evidence; evidence: the counts and recency you base it on.
- consensus: belief: what the field currently believes about the problem, in two or three sentences; work_ids: the work ids it rests on.

${brief}

Year spread of all results: ${JSON.stringify(years)}

${hitsBlock(results, queries, 12)}`,
        schema: obj({
          prior_art: obj({ verdict: enm(['novel', 'partly_anticipated', 'anticipated']), closest: arr(str()), summary: str() }),
          census: obj({ ceiling: str(), evidence: str() }),
          consensus: obj({ belief: str(), work_ids: arr(str()) }),
        }),
      })
      paper.state.positioning = {
        priorArt: { verdict: reply.prior_art.verdict, closest: (reply.prior_art.closest ?? []).filter((id: string) => paper.state.works[id]), summary: reply.prior_art.summary },
        census: reply.census,
        consensus: { belief: reply.consensus.belief, workIds: (reply.consensus.work_ids ?? []).filter((id: string) => paper.state.works[id]) },
      }
      paper.save()
    },
  }],
}

function positioningBlock(paper: Parameters<Behavior['ready']>[0]): string {
  const p = paper.state.positioning
  const name = (id: string) => { const w = paper.state.works[id]; return w ? `${w.title} (${w.year ?? 'n.d.'})` : id }
  return [
    p.priorArt ? `Prior art: ${p.priorArt.verdict}. ${p.priorArt.summary} Closest: ${p.priorArt.closest.map(name).join('; ')}` : 'Prior art: not checked.',
    p.census ? `Bottleneck: ${p.census.ceiling} (${p.census.evidence})` : 'Bottleneck: not checked.',
    p.consensus ? `Current belief: ${p.consensus.belief}` : 'Current belief: not checked.',
  ].join('\n')
}

const reviewSchema = obj({
  factors: arr(obj({ name: enm(FACTORS), score: int('0 to 3'), evidence: str(), improve: str() })),
  weakest: enm(FACTORS), ceiling: str(), verdict: enm(['worth_writing', 'reformulate', 'no_contribution']), summary: str(),
})

export function toReview(reply: any): IdeaReview {
  return {
    verdict: reply.verdict,
    factors: (reply.factors ?? []).map((f: any): Factor => ({ name: f.name, score: Math.max(0, Math.min(3, Number(f.score) || 0)), evidence: f.evidence, improve: f.improve })),
    weakest: reply.weakest, ceiling: reply.ceiling, summary: reply.summary,
  }
}

export const reviewIdea: Behavior = {
  id: 'review-idea', stage: 'aim', improver: true, title: 'Review the idea',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.brief?.hasSubject || s.ideaReview) return []
    if (!paper.isSettled('position:seed') && !paper.config.off.includes('position')) return []
    return [{
      key: 'review-idea:seed', label: 'the idea against the standard',
      run: async () => {
        const reply = await paper.ask<any>({
          behavior: 'review-idea', target: 'seed', seat: 'challenger', family: seatFamily(paper, 'challenger'),
          prompt: `${HOUSE}

${BLUEPRINT}

Challenge the idea below against the standard before a word of the paper is written. Score each of the seven factors from 0 (absent) to 3 (strong), with the evidence for the score and what would raise it. Name the weakest factor. State the ceiling: if this works perfectly, which strangers change what they do next. Verdict: worth_writing when the weakest factor scores at least 2; reformulate when a different framing of the same concern could lift the weakest factor; no_contribution only when no paper could come of it.

${briefBlock(paper)}

Claims in the seed:
${s.claims.map((c) => `- ${c.id} [${c.kind}] ${c.text}`).join('\n')}

${positioningBlock(paper)}`,
          schema: reviewSchema,
        })
        s.ideaReview = toReview(reply)
        paper.save()
      },
    }]
  },
}

export const reformulate: Behavior = {
  id: 'reformulate', stage: 'aim', improver: true, title: 'Reformulate',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.ideaReview || s.ideaReview.verdict === 'worth_writing' || s.directions.length) return []
    return [{
      key: 'reformulate:seed', label: 'three directions',
      run: async () => {
        const reply = await paper.ask<any>({
          behavior: 'reformulate', target: 'seed', seat: 'challenger', family: seatFamily(paper, 'challenger'),
          prompt: `${HOUSE}

${BLUEPRINT}

The idea below was judged: ${s.ideaReview!.verdict}. Weakest factor: ${s.ideaReview!.weakest}. ${s.ideaReview!.summary}

Reformulate the inquiry in exactly three materially different directions. Treat the idea as a provisional combination of a human concern, an inherited objective, an assumed world and an imagined set of actions. Each direction keeps the person's concern visible and changes something structural: the unit of inquiry, who acts or adapts, what carries the concern, a necessity that is removed, the time structure, or the framing itself. Do not produce a conservative, moderate and radical ladder. Prefer directions that lift the weakest factor.
The person's explicit commitments are binding: what the seed says it wants, rejects or requires (its design principles, its stance, what it says must or must not happen). A direction may change framing, unit, scope or emphasis, but never reverse such a commitment or build the paper around its opposite. If the seed describes something that already exists, every direction keeps presenting that thing as it is. If the seed says what the paper is (for example, the paper that introduces a system), every direction is still that paper, about the whole of its object: it may sharpen what the paper claims about it and how it shows it, but never shrinks the paper to one part of the object or swaps the object for another.

The seed, for its explicit commitments:
"""
${s.seed.text}
"""
For each: title (names the shift), question (one reformulated research question), shift (what inherited assumption changed), opens (what a good answer would let people do), residue (the tension it leaves unresolved), raises (which factor it lifts and how).

${briefBlock(paper)}

${positioningBlock(paper)}`,
          schema: obj({ directions: arr(obj({ title: str(), question: str(), shift: str(), opens: str(), residue: str(), raises: str() })) }),
        })
        s.directions = (reply.directions ?? []).slice(0, 3).map((d: any, i: number): Direction => ({ id: `D${i + 1}`, title: d.title, question: d.question, shift: d.shift, opens: `${d.opens} Raises: ${d.raises}`, residue: d.residue }))
        paper.save()
      },
    }]
  },
}

export const selectDirection: Behavior = {
  id: 'select-direction', stage: 'aim', improver: true, title: 'Select direction',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.directions.length || s.selectedDirection) return []
    return [{
      key: 'select-direction:seed', label: 'one direction',
      run: async () => {
        // Never the challenger's family: the one who proposed the directions does not pick among them.
        const reply = await paper.ask<any>({
          behavior: 'select-direction', target: 'seed', seat: 'checker', family: seatFamily(paper, 'checker'),
          prompt: `${HOUSE}

${BLUEPRINT}

Choose how this paper should go. The options are the original idea or one of three directions. First rule out every direction that reverses an explicit commitment of the seed (what it says it wants, rejects or requires), stops presenting what the seed describes as it is, or is no longer the paper the seed says it is (for example, one that presents a part of the system the seed says the paper introduces). Among the rest, choose the one whose weakest factor is highest while it still serves the person's concern. Choose none_viable only if the original verdict was no_contribution and no direction yields a contribution either.

The seed, for its explicit commitments:
"""
${s.seed.text}
"""

Original idea:
${briefBlock(paper)}
Review: ${s.ideaReview!.verdict}; weakest ${s.ideaReview!.weakest}; ${s.ideaReview!.summary}

Directions:
${s.directions.map((d) => `${d.id}: ${d.title}\n  Question: ${d.question}\n  Shift: ${d.shift}\n  Opens: ${d.opens}\n  Residue: ${d.residue}`).join('\n')}`,
          schema: obj({ choice: enm(['original', 'D1', 'D2', 'D3', 'none_viable']), reason: str() }),
        })
        if (reply.choice === 'none_viable' && s.ideaReview!.verdict === 'no_contribution') {
          s.outcome = 'no_contribution'
          paper.note('select-direction', `No contribution: ${reply.reason}`, true)
        } else {
          s.selectedDirection = { id: reply.choice === 'none_viable' ? 'original' : reply.choice, reason: reply.reason }
        }
        paper.save()
      },
    }]
  },
}

/** The aim is settled when the idea review is done or given up, and any direction is chosen. */
export function aimSettled(paper: Parameters<Behavior['ready']>[0]): boolean {
  const s = paper.state
  if (!paper.isSettled('position:seed') && !paper.config.off.includes('position')) return false
  if (paper.config.off.includes('review-idea')) return true
  if (!paper.isSettled('review-idea:seed')) return false
  if (!s.ideaReview || s.ideaReview.verdict === 'worth_writing') return true
  if (!paper.isSettled('reformulate:seed')) return paper.config.off.includes('reformulate')
  if (!s.directions.length) return true
  return paper.isSettled('select-direction:seed') || paper.config.off.includes('select-direction')
}

export const plan: Behavior = {
  id: 'plan', stage: 'skeleton', improver: false, title: 'Plan the argument',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.brief?.hasSubject || s.plan || !aimSettled(paper)) return []
    // With a dataset, the argument is planned on what it shows.
    if ((paper.config.materials ?? []).some((m) => m.kind === 'dataset') && !s.measurements && !paper.config.off.includes('analyze')) return []
    // With a simulation, the argument is planned on what it shows.
    if (paper.config.simulation && !s.simulations && !paper.config.off.includes('simulate')) return []
    // A paper whose contribution is its systematic review is planned once the review is in.
    if (paper.config.literatureReview === 'load-bearing' && s.literature?.status !== 'done' && s.literature?.status !== 'failed' && !paper.config.off.includes('literature-review')) return []
    return [{
      key: 'plan:argument', label: 'the argument',
      run: async () => {
        const review = s.ideaReview ? `Idea review: ${s.ideaReview.verdict}; weakest factor ${s.ideaReview.weakest}. ${s.ideaReview.summary}\n${s.ideaReview.factors.map((f) => `  ${f.name}: ${f.score}/3. ${f.evidence} To raise it: ${f.improve}`).join('\n')}` : ''
        const reply = await paper.ask<any>({
          behavior: 'plan', target: 'argument', seat: 'author', family: seatFamily(paper, 'author'),
          prompt: `${HOUSE}

${BLUEPRINT}

Plan the argument of the paper. The seed is the person's; keep its concern and its claims unless a claim is wrong or out of scope for the chosen direction.
- thesis: the one sentence the paper argues.
- working_title: a plain working title.
- noun: the name the paper gives its central idea, method or artifact, if it has one (else an empty string).
- opens: 3 to 6 concrete next papers strangers could write because this one exists.
- claims: the complete set of claims the argument needs. For each seed claim give its id and action keep, reword or drop (with the reason). Add the claims the argument needs that the seed lacks (id null, action add): background claims about prior work and the state of the field that the paper must establish with citations, and contribution claims that state exactly what this paper delivers. kind is contribution, background, method, novelty or common_knowledge. need is external (must be cited: other people's published work), internal (backed by the authors' own work: what this paper presents, and systems, tools or results the authors themselves built, as the seed's "we" and "our" show) or none (common knowledge or a definition). load_bearing is true when the thesis falls if the claim falls. depends_on lists the ids of claims this one rests on (no cycles).
Lift the weakest factor where the evidence allows it, but never claim more than can be supported.
A claim about the authors' data rests on the measurements: it names the ones it uses (A1, A2), has need internal, says only what they show, and writes any number from them as its placeholder ({{data.A1}}), with its interval ({{data.A1.ci}}) where it has one. A method claim names only analyses that ran; a planned analysis that did not run is never a claim. A claim about a simulation rests on its results: it names the simulation (S1), has need internal, says only what the results show under the simulation's assumptions, and writes any number from them as its placeholder ({{sim.S1.profit.p95}}). Aim for about ${Math.max(8, Math.min(40, Math.round(paper.config.words / 230)))} claims in total, scaled to a paper of about ${paper.config.words} words.

${briefBlock(paper)}
${review}
${positioningBlock(paper)}

${paper.config.literatureReview === 'load-bearing' && s.literature?.status === 'done' ? `\nTHE PAPER'S MAIN CONTRIBUTION IS ITS SYSTEMATIC REVIEW. The thesis states what the review establishes about its question. The review's findings (marked "review finding" below) are the paper's contribution claims: keep each one as it is (action keep), give it kind contribution, need external, and load_bearing true when the thesis rests on it. Add only the claims a review paper needs to frame them, never a contribution beyond what the review found.\n` : ''}${paper.config.simulation === 'load-bearing' && Object.keys(s.simulations ?? {}).length ? `\nTHE PAPER'S MAIN CONTRIBUTION RESTS ON ITS SIMULATION. The thesis states what the simulation shows. The contribution claims are claims about its results (need internal, load_bearing true), each naming the simulation and writing its numbers as placeholders. State the assumptions the results depend on as claims too, so the paper argues from them openly.\n` : ''}
Seed claims:
${s.claims.filter((c) => c.origin !== 'review' || paper.config.literatureReview === 'load-bearing').map((c) => `- ${c.id} [${c.kind}${c.origin === 'review' ? ', review finding' : ''}] ${c.text}${c.seedQuote ? ` (seed: "${c.seedQuote}")` : ''}`).join('\n')}`,
          schema: obj({
            thesis: str(), working_title: str(), noun: str(), opens: arr(str()),
            claims: arr(obj({ id: nstr(), action: enm(['keep', 'reword', 'drop', 'add']), text: str(), kind: enm(KINDS), need: enm(['external', 'internal', 'none']), load_bearing: bool(), depends_on: arr(str()), reason: str() })),
          }),
        })
        s.plan = { thesis: reply.thesis, workingTitle: reply.working_title, noun: reply.noun || '', opens: reply.opens ?? [], objectType: s.brief!.objectType }
        for (const c of reply.claims ?? []) {
          const existing = c.id ? claim(paper, c.id) : undefined
          if (existing && c.action === 'drop') { setClaim(paper, existing, 'dropped', 'plan', c.reason); continue }
          const target = existing ?? (() => {
            const added: Claim = { id: nextClaimId(paper), text: c.text, kind: c.kind, seedQuote: '', origin: 'system', need: c.need, loadBearing: false, dependsOn: [], status: 'open', history: [{ at: now(), behavior: 'plan', from: '', to: c.text, reason: c.reason }] }
            s.claims.push(added)
            return added
          })()
          if (existing && c.action === 'reword' && c.text.trim() !== existing.text) setClaim(paper, existing, existing.status, 'plan', c.reason, c.text)
          target.kind = c.kind
          target.need = c.need
          target.loadBearing = !!c.load_bearing
          target.dependsOn = (c.depends_on ?? []).filter((id: string) => id !== target.id)
        }
        // A finding of the systematic review keeps the sources it was imported with.
        for (const c of s.claims) if (c.origin === 'review') c.need = 'external'
        // Claims that need no outside evidence are settled now.
        for (const c of activeClaims(paper)) {
          if (c.status !== 'open') continue
          if (c.need === 'internal') setClaim(paper, c, 'internal', 'plan', 'backed by the authors\' own work')
          if (c.need === 'none') setClaim(paper, c, 'assumed', 'plan', 'common knowledge or a stated premise')
          if (c.need === 'external' && paper.config.off.includes('find-evidence')) setClaim(paper, c, 'unsupported', 'plan', 'evidence search is switched off for this paper')
        }
        paper.save()
      },
    }]
  },
}

export const outline: Behavior = {
  id: 'outline', stage: 'skeleton', improver: false, title: 'Outline',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.plan || s.outline) return []
    return [{
      key: 'outline:paper', label: 'sections, venue and style',
      run: async () => {
        const reply = await paper.ask<any>({
          behavior: 'outline', target: 'paper', seat: 'author', family: seatFamily(paper, 'author'),
          prompt: `${HOUSE}

${STYLE}

Outline the paper for ${paper.config.venue} in the host field (${s.brief!.field}), about ${paper.config.words} words in total.
- sections: in order. Each has an id (S1, S2, …), a title, its purpose in one or two sentences, the ids of the claims it establishes, and its word budget. Every load-bearing claim is placed in exactly one section; other claims where they help, or nowhere. Use the host field's conventional structure. ${paper.config.literatureReview === 'load-bearing' && s.literature?.status === 'done' ? 'This paper is a systematic review; structure it as one: Introduction; Methods (the review\'s protocol: question, source and queries, eligibility, screening, full-text reading, independent audit); Results (the findings, by theme); Discussion (where studies disagree, what is left open, what follows); Limitations; Conclusion. Place the review\'s findings in Results.' : paper.config.literatureReview && s.literature?.status !== 'failed' ? 'A systematic literature review section is placed after the introduction for you: do not include a separate related-work section; position the paper against prior work in the introduction and the discussion.' : 'Include a section on related work.'}${paper.config.simulation === 'load-bearing' && Object.keys(s.simulations ?? {}).length ? ' The paper is built around its simulation: include a section that specifies the model (method, inputs with their bases, model lines, events, checks), a results section, and a section on how the results depend on the assumptions; chart the main results.' : ''} Include a section stating the limitations, and a closing section that names what this opens. Do not include an abstract or a references section; those are written later.
- figures: at most three in the whole paper, each in the section it belongs to, with an id (fig1, …), a caption, and a spec precise enough to draw it. A figure is a diagram of a structure the paper describes (a pipeline, a set of roles, a lifecycle) or a chart of numbers the paper states. Never a figure that needs data the paper does not have.${s.simulations && Object.keys(s.simulations).length ? ' A simulation\'s results can be charted from its run: the distribution of an output, or a sequential run\'s bands over time.' : ''}
- style: notes on register and conventions for this venue and field.
- glossary: the terms the paper defines, as "term: definition", including the paper's noun.

${briefBlock(paper)}
What this opens: ${s.plan!.opens.join('; ')}

Claims:
${activeClaims(paper).filter((c) => c.origin !== 'review' || paper.config.literatureReview === 'load-bearing').map((c) => `- ${c.id} [${c.kind}${c.loadBearing ? ', load-bearing' : ''}] ${c.text}`).join('\n')}`,
          schema: obj({
            sections: arr(obj({ id: str(), title: str(), purpose: str(), claim_ids: arr(str()), words: int(), figures: arr(obj({ id: str(), caption: str(), spec: str() })) })),
            style: str(), glossary: arr(str()),
          }),
        })
        const sections = (reply.sections ?? []).map((sec: any, i: number) => ({
          id: `S${i + 1}`, title: String(sec.title).replace(/^\d+(\.\d+)*\.?\s+/, ''), purpose: sec.purpose,
          claimIds: (sec.claim_ids ?? []).filter((id: string) => claim(paper, id)), words: Math.max(150, Number(sec.words) || 600),
          figureIds: (sec.figures ?? []).map((f: any) => f.id),
        }))
        s.outline = { sections, style: reply.style, glossary: reply.glossary ?? [] }
        // The systematic review gets its own section after the introduction; its findings fill it once Canary is done.
        if (paper.config.literatureReview === true && s.literature?.status !== 'failed') {
          s.outline.sections = withReviewSection(s.outline.sections, paper.config.words)
          const review = s.outline.sections.find((sec) => sec.id === REVIEW_SECTION)
          if (review && s.literature?.status === 'done') review.claimIds = s.literature.claimIds ?? []
        }
        s.figures = (reply.sections ?? []).flatMap((sec: any, i: number) => (sec.figures ?? []).map((f: any) => ({ id: String(f.id).replace(/[^A-Za-z0-9_-]/g, ''), caption: f.caption, spec: f.spec, sectionId: `S${i + 1}`, status: 'planned' as const }))).slice(0, 3)
        const placed = new Set(sections.flatMap((sec: { claimIds: string[] }) => sec.claimIds))
        const missing = activeClaims(paper).filter((c) => c.loadBearing && !placed.has(c.id))
        if (missing.length) {
          const last = sections.find((sec: { title: string }) => /discussion/i.test(sec.title)) ?? sections[Math.max(0, sections.length - 2)]
          last.claimIds.push(...missing.map((c) => c.id))
          paper.note('outline', `Placed load-bearing claims the outline left out (${missing.map((c) => c.id).join(', ')}) in "${last.title}".`)
        }
        paper.save()
      },
    }]
  },
}
