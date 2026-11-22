// The fixed parts of every prompt: who is asking, the standard a paper is
// held to, and how it should read.

export const HOUSE = `You hold one seat in galley, a system that turns a person's seed text into a pre-publication academic manuscript. Several model families take different seats, and no family reviews its own work. Work only from the material in this request. Never invent sources, citations, numbers, quotations, data or results. When something is not known, say so plainly. Return a single JSON object that follows the response schema exactly, with no Markdown fences or commentary.`

export const BLUEPRINT = `The standard. Once venue, author status and visibility are set aside, papers that reach exceptional long-run impact share seven features, and they multiply: one near-zero factor sinks a paper.
1. Input, not output: the paper delivers a capability, a coordinate system (benchmark, dataset, standard, map), a generative frame, or new territory others can enter with tools they already own. A correct finding about one system is none of these.
2. Shared bottleneck: many people are blocked by the problem before the paper exists.
3. Conventional body, one graft: mostly the host field's own language, questions and references, plus one atypical combination imported from elsewhere.
4. Surprising and certain: improbable beforehand, undeniable afterwards, holding up in strangers' hands.
5. Opens more than it closes: after reading it, many people know what their next paper is.
6. Cheap to adopt: a noun the field needs, one idea, and something usable outside its original setting.
7. Early: at the base of a field's growth curve, often just after a new instrument, dataset or capability made the attack possible.`

export const STYLE = `How it reads. Plain, precise academic English in the host field's own register. Short declarative sentences and concrete nouns. Define a term once and keep it. Active voice. Numbers carry units. One idea per paragraph, the paragraph's point in its first sentence. No hype or filler: never "groundbreaking", "revolutionary", "paradigm shift", "game-changing", "delve", "crucial", "pivotal", "landscape", "tapestry", "realm", "underscore", "showcase", "leverage", "harness", "seamless", "unlock", "empower", "it is important to note", "in today's world". No rhetorical questions, no addressing the reader, no bullet lists in body text unless the content is a true list.
Write as a finished paper: state what the work is, does and shows. Never narrate how this manuscript is being produced (stages, revisions, "provisional", "when it has run", "at this revision"), never describe what a system does if one of its steps fails or is skipped, and never comment on what this text does or does not document.
The text carries no caution about itself. It states its claims and results plainly: no hedges on its own claims (may, might, could, appears to, seems, suggests, likely, preliminary, tentative), no limitations or caveats, no disclaimers about what it does not establish, and no remark on how it was produced, reviewed or checked, or on who did or did not review it. Caution has its place: a note for the authors, shown beside the text as a comment in the editor and never printed. The limits of the work are printed in one place only, the paper's Limitations section, which is written from those notes once the paper has been reviewed. Where a request lets you give notes, put every limit, doubt or missing source there.
Unless the paper is about galley itself, never use galley's working terms in the text: the claim ledger, claim ids, verified or unverified passages or citations, an evidence base, a world model, seats, model families, gates, the run. Cite the sources themselves, and say what they show.`

export const PLACEHOLDERS: Record<string, string> = {
  'run.hours': 'wall-clock hours from seed to this manuscript',
  'run.calls': 'number of model calls made',
  'run.calls_claude': 'model calls answered by Claude Opus 5.5',
  'run.calls_gpt': 'model calls answered by GPT-6.2 Sol',
  'run.calls_gemini': 'model calls answered by Gemini 4 Carbon',
  'run.tokens_in_m': 'input tokens, in millions',
  'run.tokens_out_k': 'output tokens, in thousands',
  'run.behaviors': 'number of distinct behaviors that ran',
  'run.claims': 'claims in the final argument',
  'run.claims_seed': 'claims that came from the seed',
  'run.claims_added': 'claims the system added',
  'run.claims_review': 'claims that are findings of the literature review, when the paper has one',
  'run.claims_narrowed': 'claims narrowed to what their evidence supports',
  'run.claims_unsupported': 'claims left without external evidence and hedged',
  'run.works_screened': 'candidate works screened for evidence',
  'run.citations_verified': 'citations verified against their passages',
  'run.citations_rejected': 'proposed citations rejected by the verifier',
  'run.findings': 'referee findings in total',
  'run.findings_material': 'material or critical referee findings',
  'run.findings_resolved': 'material or critical findings settled: fixed, rebutted or left for the authors as limitations with the agreement of the referee who raised them, decided by a third model family, or set aside by you',
  'run.findings_adjudicated': 'findings settled by a third model family',
  'run.findings_fixed': 'material or critical findings fixed, with the agreement of the referee who raised them',
  'run.findings_rebutted': 'material or critical findings rebutted, with the agreement of the referee who raised them',
  'run.findings_limitation': 'material or critical findings left for the authors as limitations, beside the text, with the agreement of the referee who raised them',
  'run.findings_decided': 'material or critical findings decided by a third model family, with the decision made in the text',
  'run.findings_set_aside': 'material or critical findings a third model family judged not to hold, each with the text answering the point',
  'run.findings_fallback': 'material or critical findings adjudication could not settle in the text, left for the authors beside the text',
  'run.findings_yours': 'material or critical findings you set aside in the editor',
  'run.findings_open': 'material or critical findings still open',
  'run.rounds': 'referee rounds',
  'run.calibration': 'planted defective citations the verifier caught, as "caught of planted"',
  'run.calibration_controls': 'unaltered control citations the verifier accepted, as "accepted of controls"',
}

export function placeholderGuide(): string {
  return Object.entries(PLACEHOLDERS).map(([key, meaning]) => `{{${key}}}: ${meaning}`).join('\n')
}
