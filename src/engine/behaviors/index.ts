// The ladder: every behavior in the order it was built and proven. The
// scheduler scans it top to bottom, so earlier rungs always react first.
// One ladder serves both branches: a run takes the rungs of its own mode (a
// paper's, or a thesis's), and the rungs they share serve both.
import type { Behavior } from '../scheduler.js'
import { calibrate, finalFrame, ready, reconcile, reprofile, typeset } from './close.js'
import { extract, outline, plan, position, reformulate, reviewIdea, selectDirection } from './front.js'
import { adjudicate, closeRound, handleFinding, referee, respond, verifyDisposition } from './review.js'
import { findEvidence, reassess, verify } from './truth.js'
import { draft, fidelity, figure, frame as firstFrame } from './write.js'
import { analyzeData, extractData, planAnalysis, reviewAnalysisPlan } from './data.js'
import { literatureReview } from './literature.js'
import { simulateModel } from './simulate.js'
import { softwareEvaluation } from './software.js'
import { proof } from './proof.js'
import { citeNamed } from './named.js'
import { copyedit } from './copyedit.js'
import { findWebSources } from './web.js'
import { storyCaveats, storyCharts, storyExample, storyLead, storyRead, storyRegister } from './story.js'
import { formulateThesis, testThesis, thesisBrief } from './thesis.js'

// One behavior writes the frame: once when the draft is checked, and again from the reviewed text.
const frame: Behavior = { ...firstFrame, ready: (paper) => [...firstFrame.ready(paper), ...finalFrame(paper)] }

export const LADDER: Behavior[] = [
  // Skeleton: a seed becomes a typeset paper.
  extract,
  // Introductions evaluate the revision early. Instruments serve the chosen direction.
  softwareEvaluation,
  // Aim: is this worth writing, and in which direction?
  position, reviewIdea, reformulate, selectDirection,
  // When asked for, and always for a thesis: a literature review, by Canary, in the background.
  literatureReview,
  // The thesis branch: from the stance the person chose, one thesis against what the field holds, tested for that stance,
  // and the brief a later paper can start from.
  formulateThesis, testThesis, thesisBrief,
  // With the authors' data: plan the analysis to the field's standard, have a statistician review it, run it, then argue.
  planAnalysis, reviewAnalysisPlan, extractData, analyzeData,
  // When asked for: the Monte Carlo simulation the argument needs, run on this machine.
  simulateModel,
  plan, outline,
  // Truth: every external claim gets a verified passage, or is hedged.
  findEvidence, verify, findWebSources, reassess, calibrate,
  draft, figure, fidelity, frame,
  // Referees: other families review; the author answers; a third family settles; what it cannot settle becomes a limitation.
  referee, closeRound, respond, verifyDisposition, adjudicate, handleFinding,
  // Close: every work the text names is cited; the reviewed research is told (its caveats in one Limitations section, its
  // findings first, a worked example, one register, its charts); the whole text is copyedited for consistency and the
  // ledger made to say what it says; after the final frame the paper is read through three times; then it is profiled,
  // typeset and read as printed.
  citeNamed, storyCaveats, storyLead, storyExample, storyRegister, storyCharts, copyedit, reconcile, storyRead, reprofile, typeset, proof, ready,
]
