// The ladder: every behavior in the order it was built and proven. The
// scheduler scans it top to bottom, so earlier rungs always react first.
import type { Behavior } from '../scheduler.js'
import { calibrate, finalFrame, ready, reconcile, reprofile, typeset } from './close.js'
import { extract, outline, plan, position, reformulate, reviewIdea, selectDirection } from './front.js'
import { adjudicate, closeRound, handleFinding, referee, respond, verifyDisposition } from './review.js'
import { findEvidence, reassess, verify } from './truth.js'
import { draft, fidelity, figure, frame as firstFrame } from './write.js'
import { analyzeData } from './data.js'
import { literatureReview } from './literature.js'
import { simulateModel } from './simulate.js'
import { proof } from './proof.js'
import { findWebSources } from './web.js'

// One behavior writes the frame: once when the draft is checked, and again from the reviewed text.
const frame: Behavior = { ...firstFrame, ready: (paper) => [...firstFrame.ready(paper), ...finalFrame(paper)] }

export const LADDER: Behavior[] = [
  // Skeleton: a seed becomes a typeset paper.
  extract,
  // Aim: is this worth writing, and in which direction?
  position, reviewIdea, reformulate, selectDirection,
  // When asked for: a systematic review of the literature, by Canary, in the background.
  literatureReview,
  // With the authors' data: measure, then argue.
  analyzeData,
  // When asked for: the Monte Carlo simulation the argument needs, run on this machine.
  simulateModel,
  plan, outline,
  // Truth: every external claim gets a verified passage, or is hedged.
  findEvidence, verify, findWebSources, reassess, calibrate,
  draft, figure, fidelity, frame,
  // Referees: other families review; the author answers; a third family settles; what it cannot settle becomes a limitation.
  referee, closeRound, respond, verifyDisposition, adjudicate, handleFinding,
  // Close: the ledger is made to say what the reviewed text says, then the paper is profiled, typeset and read as printed.
  reconcile, reprofile, typeset, proof, ready,
]
