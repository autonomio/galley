// The thesis branch of the one ladder. A thesis run shares the seed, the placing of the idea and the literature review
// with a paper; from there it takes its direction from the stance the person chose (extend, contest or reframe),
// formulates one thesis against what the field holds, tests it for that stance, and hands it back as a brief that a
// later paper can start from.
import type { Stance } from '../config.js'
import { canarySearch, type SearchHit } from '../evidence.js'
import { HOUSE } from '../prompts.js'
import { writeThesisBrief } from '../render.js'
import type { Behavior } from '../scheduler.js'
import { arr, bool, enm, obj, str, type Schema } from '../schema.js'
import type { Paper } from '../paper.js'
import type { Thesis } from '../types.js'
import { briefBlock, keyFor, live, seatFamily } from './common.js'
import { aimSettled, positioningBlock } from './front.js'

/** What each stance asks of the thesis, and the test it must meet. */
export const STANCES: Record<Stance, { name: string; gist: string; task: string; test: string }> = {
  extend: {
    name: 'Extend',
    gist: 'builds on what the field holds',
    task: 'Your stance is extend: build on what the field holds. The thesis is the next step that the strongest position supports but has not yet taken. What it rests on is what the sources establish; what it adds is the step itself, which must not already be taken.',
    test: 'Extend: the step follows from what the field has established, as its sources show, and none of the closest work already takes it.',
  },
  contest: {
    name: 'Contest',
    gist: 'goes against what the field holds',
    task: 'Your stance is contest: go against what the field holds. Name the position, and the assumption it rests on, that the thesis says is wrong. State that position at its strongest, from its sources, and the findings that run against it (the review\'s contradictions and gaps). The thesis says what holds instead, and decides names the observation or comparison that would settle the matter between the field\'s position and the thesis.',
    test: 'Contest: the contested position is stated as the field holds it, at its strongest and from its sources; the thesis names what would decide between the two; and none of the closest work has already established the thesis.',
  },
  reframe: {
    name: 'Reframe',
    gist: 'goes beyond what the field holds, onto another axis',
    task: 'Your stance is reframe: go beyond what the field holds, onto another axis, neither building on a position nor contesting one. Look between the positions, at what none of them can ask; at the assumption they all share; or at the subject taken with a different unit, scale, purpose or time horizon. The first idea that forms is usually the obvious move, often the opposite of one position: name it as set_aside, put it aside, and look again. The thesis is a framing or a question the field cannot ask today; depends_on says what it rests on, and decides what would make it real.',
    test: 'Reframe: the thesis lies on another axis, and is not merely the opposite of a position or of what was set aside; and none of the closest work already states it.',
  },
}

/** How the review question leans for each stance, so the literature answers what the thesis needs. */
export const STANCE_REVIEW: Record<Stance, string> = {
  extend: '- The thesis will build on what the field holds: ask what the field has established about the subject, so the review finds the strongest positions and where they stop.',
  contest: '- The thesis will go against what the field holds: ask what the field\'s current consensus about the subject is, so the review finds that consensus, what it rests on and the findings that run against it.',
  reframe: '- The thesis will go beyond what the field holds: ask how the field approaches the subject, so the review finds its main positions and what they take for granted.',
}

const stanceOf = (paper: Paper): Stance => paper.config.stance ?? 'extend'

/** The review's findings with the keys of the sources behind them, its gaps and its contradictions. */
function literatureBlock(paper: Paper): string {
  const s = paper.state
  const lit = s.literature
  if (lit?.status !== 'done') return 'THE LITERATURE REVIEW did not finish: the field is mapped from the prior-art search alone.'
  const keys = (claimId: string) => [...new Set(s.citations.filter((c) => c.claimId === claimId && c.status === 'verified').map((c) => s.works[c.workId]).filter(Boolean).map((w) => `@${keyFor(paper, w)}`))]
  const findings = s.claims.filter((c) => c.origin === 'review' && c.status !== 'dropped')
  return [
    `THE LITERATURE REVIEW (Canary, ${lit.searchedOn}): "${lit.question}". ${lit.counts?.reviewed ?? 0} publications read in full and included.`,
    `Its findings, each with the sources it rests on:\n${findings.map((c) => `- ${c.text}${c.uncertainty ? ` (uncertainty ${c.uncertainty})` : ''} ${keys(c.id).join(' ')}`).join('\n') || '(none)'}`,
    lit.gaps?.length ? `Where the studies are silent:\n${lit.gaps.map((g) => `- ${g}`).join('\n')}` : '',
    lit.contradictions?.length ? `Where the studies disagree:\n${lit.contradictions.map((k) => `- ${k}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

const thesisSchema: Schema = obj({
  positions: arr(obj({ name: str(), holds: str(), rests_on: str(), sources: arr(str()) })),
  shared_assumption: str(), set_aside: str(), thesis: str(), title: str(), relation: str(),
  conditions: arr(obj({ statement: str(), status: enm(['given', 'assumed', 'supported', 'unknown']), sources: arr(str()) })),
  depends_on: arr(str()), decides: str(), opens: str(), residue: str(), novelty_queries: arr(str()),
})

function formulatePrompt(paper: Paper, revise?: { thesis: Thesis; objections: string[] }): string {
  const stance = STANCES[stanceOf(paper)]
  return `${HOUSE}

You are formulating a thesis, not writing a paper: one proposition worth exploring, which takes a clear stance toward what the field holds. It is speculation to be explored further, not a claim to prove now, so it needs no evidence of its own yet; what it needs is a clear stance, the conditions it holds under, what it depends on and what would decide it.

First map the field from the review's findings and the prior-art search: the 2 to 6 positions that draw most of the work on this subject. For each give what it holds, and rests_on: the assumption it rests on, without which it would fall, with the sources that show it (their keys, as listed below, without the @). Then shared_assumption: an assumption every position shares and none examines, or empty if there is none.

${stance.task}

- thesis: one sentence in plain words, at most 40 words.
- title: at most 12 words, clear to a reader who has not read the brief, claiming nothing the thesis does not.
- relation: two or three sentences on how the thesis stands to the positions.
- conditions: what the thesis holds under, each marked by what holds it up: given (the seed states it), assumed (the thesis assumes it), supported (a source shows it; name its keys) or unknown (nobody has established it).
- depends_on: the conditions under which it would stop holding.
- decides: what would decide it: the observation, comparison or argument that would settle it.
- opens: what a good answer would let someone understand, investigate or stop doing.
- residue: the tension it leaves unresolved, or empty if none is apparent.
- novelty_queries: two or three literature searches that would find work already stating this thesis.
${stanceOf(paper) === 'reframe' ? '' : '- set_aside: empty.\n'}Use only the sources listed below, by key. Write in the field's words; a term the field does not use is explained where it appears. Say nothing about how this thesis was produced.

${briefBlock(paper)}

THE SEED, as the person wrote it:
"""
${paper.state.seed.text}
"""

THE IDEA PLACED IN THE FIELD:
${positioningBlock(paper)}

${literatureBlock(paper)}${revise ? `

A reader from another family tested this thesis for its stance and found:
${revise.objections.map((o) => `- ${o}`).join('\n')}

THE THESIS AS IT STOOD: ${revise.thesis.statement}
Formulate it again from the same stance, so that it meets its test.` : ''}`
}

function toThesis(paper: Paper, reply: any, revision: number): Thesis {
  const list = (x: unknown) => (Array.isArray(x) ? x : []).map((v) => String(v ?? '').trim()).filter(Boolean)
  const keys = (x: unknown) => list(x).map((k) => k.replace(/^@/, ''))
  return {
    stance: stanceOf(paper),
    statement: String(reply.thesis ?? '').trim(),
    title: String(reply.title ?? '').trim().replace(/^["“]|["”]$/g, ''),
    relation: String(reply.relation ?? '').trim(),
    positions: (reply.positions ?? []).map((p: any) => ({ name: String(p.name ?? '').trim(), holds: String(p.holds ?? '').trim(), restsOn: String(p.rests_on ?? '').trim(), sources: keys(p.sources) })).filter((p: { name: string }) => p.name),
    sharedAssumption: String(reply.shared_assumption ?? '').trim(),
    setAside: stanceOf(paper) === 'reframe' ? String(reply.set_aside ?? '').trim() : '',
    conditions: (reply.conditions ?? []).map((c: any) => ({ statement: String(c.statement ?? '').trim(), status: ['given', 'assumed', 'supported', 'unknown'].includes(c.status) ? c.status : 'unknown', sources: keys(c.sources) })).filter((c: { statement: string }) => c.statement),
    dependsOn: list(reply.depends_on),
    decides: String(reply.decides ?? '').trim(),
    opens: String(reply.opens ?? '').trim(),
    residue: String(reply.residue ?? '').trim(),
    noveltyQueries: list(reply.novelty_queries).slice(0, 3),
    revision,
  }
}

/** Whether the literature the thesis is formulated from has come in, or will not. */
function literatureSettled(paper: Paper): boolean {
  const lit = paper.state.literature
  if (!paper.config.literatureReview || paper.config.off.includes('literature-review')) return true
  return !!lit && lit.status !== 'running'
}

export const formulateThesis: Behavior = {
  id: 'formulate', stage: 'thesis', modes: ['thesis'], improver: false, title: 'Formulate the thesis',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || s.thesis || !s.brief?.hasSubject || !aimSettled(paper) || !literatureSettled(paper)) return []
    return [{
      key: 'formulate:thesis', label: `the thesis, ${STANCES[stanceOf(paper)].name.toLowerCase()}`,
      run: async () => {
        const reply = await paper.ask<any>({ behavior: 'formulate', target: 'thesis', seat: 'author', family: seatFamily(paper, 'author'), prompt: formulatePrompt(paper), schema: thesisSchema })
        const thesis = toThesis(paper, reply, 0)
        if (!thesis.statement) throw new Error('the reply held no thesis')
        s.thesis = thesis
        paper.save()
      },
    }]
  },
}

/** The closest work a search finds for the thesis, so a reader can say whether it is already stated. */
async function closestWork(paper: Paper, thesis: Thesis): Promise<SearchHit[]> {
  if (paper.config.worldModel?.only || !thesis.noveltyQueries.length) return []
  const queries = thesis.noveltyQueries.map((search, i) => ({ id: `t${thesis.revision}q${i + 1}`, search }))
  try {
    const results = await canarySearch(paper.path('canary', 'thesis'), `galley:${paper.state.slug}:thesis`, queries, 8,
      (ms, why) => paper.say(`… test-thesis: ${why}; next try in ${Math.round(ms / 1000)}s`))
    const seen = new Set<string>()
    return Object.values(results).flatMap((r) => r.results).filter((hit) => !seen.has(hit.id) && seen.add(hit.id)).slice(0, 20)
  } catch (error) {
    paper.note('test-thesis', `The search for work already stating the thesis did not run: ${(error as Error).message}`, true)
    return []
  }
}

async function judge(paper: Paper, thesis: Thesis): Promise<{ passes: boolean; objections: string[]; already: string[]; family: string }> {
  const stance = STANCES[thesis.stance]
  const hits = await closestWork(paper, thesis)
  const family = seatFamily(paper, 'challenger')
  const reply = await paper.ask<any>({
    behavior: 'test-thesis', target: `revision-${thesis.revision}`, seat: 'challenger', family,
    prompt: `${HOUSE}

Test a thesis for its stance toward the field. Judge it only by this test:
${stance.test}
Work from the field as mapped below, the literature review's findings and the closest work a search found. A thesis is speculation to explore further, so do not ask it to be proven; ask whether it meets its stance's test.
Return passes (true when it meets the test), objections (each a concrete problem with the thesis, empty when it passes) and already (the titles of closest works that already state it, empty when none does).

THE THESIS (${stance.name}: ${stance.gist}): ${thesis.statement}
How it stands to the field: ${thesis.relation}
${thesis.setAside ? `The first idea, set aside: ${thesis.setAside}\n` : ''}
THE FIELD'S POSITIONS:
${thesis.positions.map((p) => `- ${p.name}: holds ${p.holds}; rests on ${p.restsOn}`).join('\n')}
${thesis.sharedAssumption ? `Shared by all of them: ${thesis.sharedAssumption}\n` : ''}
${literatureBlock(paper)}

THE CLOSEST WORK A SEARCH FOUND:
${hits.length ? hits.map((h) => `- ${h.title} (${h.year ?? 'n.d.'}). ${h.abstract.slice(0, 600)}`).join('\n') : '(the search found none, or did not run)'}`,
    schema: obj({ passes: bool(), objections: arr(str()), already: arr(str()) }),
  })
  return { passes: !!reply.passes, objections: (reply.objections ?? []).map(String).filter(Boolean), already: (reply.already ?? []).map(String).filter(Boolean), family }
}

export const testThesis: Behavior = {
  id: 'test-thesis', stage: 'thesis', modes: ['thesis'], improver: true, title: 'Test the thesis against the literature',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.thesis || s.thesis.test) return []
    return [{
      key: 'test-thesis:thesis', label: `the thesis against the literature, for its stance`,
      run: async () => {
        let verdict = await judge(paper, s.thesis!)
        // A thesis that misses its test is formulated again once, with the objections; what the second test finds stands.
        if (!verdict.passes && s.thesis!.revision === 0) {
          const first = s.thesis!
          const reply = await paper.ask<any>({ behavior: 'formulate', target: 'revision-1', seat: 'author', family: seatFamily(paper, 'author'), prompt: formulatePrompt(paper, { thesis: first, objections: [...verdict.objections, ...verdict.already.map((t) => `already stated in: ${t}`)] }), schema: thesisSchema })
          const second = toThesis(paper, reply, 1)
          if (second.statement) {
            s.thesis = second
            verdict = { ...await judge(paper, second) }
            s.thesis.test = { ...verdict, revisedFrom: first.statement }
            paper.save()
            return
          }
        }
        s.thesis!.test = verdict
        paper.save()
      },
      // Without a test the brief says the thesis was not tested.
      skip: () => { if (s.thesis) s.thesis.test = { passes: false, objections: ['The test against the literature did not run.'], already: [], family: '' } },
    }]
  },
}

export const thesisBrief: Behavior = {
  id: 'thesis-brief', stage: 'thesis', modes: ['thesis'], improver: false, title: 'Write the thesis brief',
  ready: (paper) => {
    const s = paper.state
    if (!live(paper) || !s.thesis?.test) return []
    return [{
      key: 'thesis-brief:final', label: 'the brief',
      run: async () => {
        await writeThesisBrief(paper)
        s.outcome = 'thesis_ready'
        paper.save()
      },
    }]
  },
}
