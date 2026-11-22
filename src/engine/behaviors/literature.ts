// The systematic review, when the paper asks for one: the author writes the
// review question, Canary does the review, and its findings join the ledger
// for the review section. It runs in the background, alongside the rest of
// the paper; only drafting the review section waits for it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { awaitReview, importReview, REVIEW_SECTION, reviewBundle, submitReview } from '../literature.js'
import { HOUSE } from '../prompts.js'
import type { Behavior } from '../scheduler.js'
import { obj, str } from '../schema.js'
import { briefBlock, live, now, seatFamily } from './common.js'
import { aimSettled } from './front.js'

export const literatureReview: Behavior = {
  id: 'literature-review', stage: 'substance', improver: true, title: 'Systematic literature review', attempts: 2,
  ready: (paper) => {
    const s = paper.state
    if (!paper.config.literatureReview || !live(paper) || !s.brief?.hasSubject || !aimSettled(paper)) return []
    if (s.literature && s.literature.status !== 'running') return []
    return [{
      key: 'literature-review:paper', label: 'systematic review (Canary)', background: true,
      run: async () => {
        if (!s.literature) {
          const reply = await paper.ask<any>({
            behavior: 'literature-review', target: 'question', seat: 'author', family: seatFamily(paper, 'author'),
            prompt: `${HOUSE}

Write the question for a systematic review of the published literature that this paper needs: what is already known about its subject. Canary will search the literature with it, screen the candidates, read the full papers and report what they establish.
- One question in plain words, at most 30 words, about the evidence in the field, not about this paper or what it contributes.
- Specific enough to judge a study in or out (name the population, phenomenon or intervention, and the outcome, where they apply), broad enough that published studies answer it.
- In the words the field's own papers use.

${briefBlock(paper)}

Return question.`,
            schema: obj({ question: str() }),
          })
          s.literature = { question: String(reply.question).trim(), status: 'running' }
          paper.save()
        }
        const lit = s.literature
        if (!lit.key) {
          lit.key = await submitReview(lit.question, `galley: ${s.plan?.workingTitle || s.slug}`)
          lit.submittedAt = now()
          paper.journal({ event: 'literature_submitted', key: lit.key, question: lit.question })
          paper.say(`… literature-review: Canary run ${lit.key} started: ${lit.question}`)
          paper.save()
        }
        const done = paper.begin({ behavior: 'literature-review', target: 'review', what: `Canary literature review ${lit.key}` })
        let status: string
        try {
          status = await awaitReview(lit.key)
        } finally {
          done()
        }
        if (status !== 'answered') {
          // The next attempt starts a fresh review rather than rejoining one that ended without an answer.
          paper.journal({ event: 'literature_unanswered', key: lit.key, status })
          lit.key = undefined
          paper.save()
          throw new Error(`Canary's review ended without an answer (${status})`)
        }
        const data = await reviewBundle(lit.key)
        mkdirSync(paper.path('canary'), { recursive: true })
        writeFileSync(paper.path('canary', 'review-bundle.json'), JSON.stringify(data))
        importReview(paper, data, 'canary/review-bundle.json')
        paper.journal({ event: 'literature_done', key: lit.key, findings: lit.claimIds?.length ?? 0, reviewed: lit.counts?.reviewed ?? 0, cited: lit.counts?.cited ?? 0 })
        paper.save()
      },
      skip: () => {
        // The paper goes on without a review section; the person sees why on the sign-off sheet.
        if (s.literature) s.literature.status = 'failed'
        else s.literature = { question: '', status: 'failed' }
        if (s.outline && !s.passages[REVIEW_SECTION]) s.outline.sections = s.outline.sections.filter((sec) => sec.id !== REVIEW_SECTION)
        paper.note('literature-review', 'The systematic review did not finish, so the paper has no review section.', true)
      },
    }]
  },
}
