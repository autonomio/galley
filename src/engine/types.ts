// The paper's state. Everything a behavior decides lands here, so a run can
// stop anywhere and resume from what it already knows.

export type Family = 'claude' | 'gpt' | 'gemini'

export type Seat =
  | 'author' // writes: extracts, plans, outlines, drafts, frames, responds
  | 'checker' // checks: queries, candidate passages, fidelity, dispositions
  | 'challenger' // challenges: the idea, its directions, the thesis, the final profile
  | 'verifier' // verifies a citation against its passage, independent of who proposed it
  | 'referee'
  | 'adjudicator'

export type ClaimKind = 'contribution' | 'background' | 'method' | 'novelty' | 'common_knowledge'
export type EvidenceNeed = 'external' | 'internal' | 'none'
export type ClaimStatus =
  | 'open' // nothing decided yet
  | 'supported' // a verified citation backs it
  | 'narrowed' // reworded to what the evidence supports, and backed
  | 'unsupported' // no evidence found or every candidate failed; the text must hedge
  | 'internal' // backed by the paper's own material or production record
  | 'assumed' // no evidence needed or possible; stated as a premise
  | 'dropped'

export interface ClaimChange {
  at: string
  behavior: string
  from: string
  to: string
  reason: string
}

export interface Claim {
  id: string
  text: string
  kind: ClaimKind
  /** Verbatim excerpt of the seed this claim comes from; empty when the system added it. */
  seedQuote: string
  origin: 'seed' | 'system' | 'review'
  /** For a finding of the systematic review: how uncertain the reviewed evidence leaves it (low means well established). */
  uncertainty?: 'low' | 'moderate' | 'high'
  need: EvidenceNeed
  loadBearing: boolean
  dependsOn: string[]
  status: ClaimStatus
  history: ClaimChange[]
}

export interface Brief {
  hasSubject: boolean
  concern: string
  contribution: string
  objectType: 'capability' | 'coordinate_system' | 'frame' | 'territory' | 'finding' | 'other'
  field: string
  audience: string
  /** The seed is about galley itself, the system producing the manuscript: its seats then read galley's description of itself. */
  aboutSystem?: boolean
}

export interface Factor {
  name: string
  score: number // 0..3
  evidence: string
  improve: string
}

export interface IdeaReview {
  verdict: 'worth_writing' | 'reformulate' | 'no_contribution'
  factors: Factor[]
  weakest: string
  ceiling: string
  summary: string
}

export interface Direction {
  id: string
  title: string
  question: string
  shift: string
  opens: string
  residue: string
}

export interface Positioning {
  priorArt?: { verdict: 'novel' | 'partly_anticipated' | 'anticipated'; closest: string[]; summary: string }
  census?: { ceiling: string; evidence: string }
  consensus?: { belief: string; workIds: string[] }
}

export interface Plan {
  thesis: string
  workingTitle: string
  noun: string
  opens: string[]
  objectType: Brief['objectType']
}

export interface Work {
  id: string // OpenAlex id (W…) or a DOI-derived id
  doi: string | null
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  abstract: string
  citedBy: number | null
  url: string | null
  bibKey?: string
  csl?: Record<string, unknown>
}

export interface Candidate {
  claimId: string
  workId: string
  passage: string // verbatim from the work's abstract or text
  fit: 'direct' | 'narrower' | 'indirect'
  role: 'support' | 'contrast' | 'review' | 'method' | 'priority'
  note: string
}

export interface Citation {
  id: string
  claimId: string
  workId: string
  passage: string
  role: Candidate['role']
  status: 'selected' | 'verified' | 'rejected'
  verdict?: { outcome: 'supported' | 'narrower' | 'not_supported'; reason: string; family: Family; narrowed?: string }
  chosenBy: 'auto' | 'human'
}

export interface Section {
  id: string
  title: string
  purpose: string
  claimIds: string[]
  words: number
  figureIds: string[]
}

export interface Revision {
  at: string
  text: string
  by: { kind: 'agent'; family: Family; model: string; seat: Seat; behavior: string } | { kind: 'human'; name: string }
  reason: string
}

export interface Passage {
  sectionId: string
  text: string
  revisions: Revision[]
  checked: 'unchecked' | 'faithful' | 'changes_requested'
}

export interface Figure {
  id: string
  caption: string
  spec: string
  sectionId: string
  status: 'planned' | 'rendered' | 'skipped'
  file?: string
  source?: string
}

export interface Frame {
  title: string
  abstract: string
  keywords: string[]
  limitations: string
  opens: string
}

export interface Disposition {
  at: string
  kind: 'fixed' | 'rebutted' | 'limitation' | 'needs_evidence'
  text: string
  edits: { old: string; new: string }[]
  family: Family
  verification?: { outcome: 'verified' | 'disagrees' | 'uncertain'; reason: string; family: Family }
}

export interface Finding {
  id: string
  round: number
  seat: string
  family: Family
  model: string
  severity: 'minor' | 'material' | 'critical'
  sectionId: string | null
  quote: string
  question: string
  alternatives: string
  evidence: string
  decision: string
  edit: { old: string; new: string } | null
  status: 'open' | 'applied' | 'fixed' | 'rebutted' | 'limitation' | 'adjudicated' | 'noted' | 'dropped'
  assignee: 'agents' | 'humans' | 'both'
  origin: 'agent' | 'human'
  dispositions: Disposition[]
  adjudication?: { decision: string; family: Family; edits: { old: string; new: string }[] }
}

export interface Note {
  at: string
  behavior: string
  text: string
  /** Shown on the sign-off sheet as something the person decides. */
  forHuman?: boolean
}

export interface Calibration {
  planted: number
  caught: number
  details: { kind: string; caught: boolean; family: Family }[]
}

export type Outcome = 'ready_for_submission' | 'no_subject' | 'no_contribution' | 'thesis_not_supported'

/** An agent's change that waits for a person: shown in the editor with Accept and Decline. */
export interface Proposal {
  id: string
  findingId: string
  description: string
  old: string
  new: string
  context_before?: string
  context_after?: string
  by: Family
  state: 'pending' | 'accepted' | 'declined'
}

/** "For this claim, choose a, b or c": the options a person picks citations from. */
export interface Choice {
  claimId: string
  options: (Candidate & { letter: string })[]
  asked: string
  answered?: { letters: string[]; at: string }
}

/** A systematic review of the literature, run by Canary, as the paper uses it. */
export interface LiteratureReview {
  question: string
  status: 'running' | 'done' | 'failed'
  /** Canary's run key, kept as soon as the run is submitted, so a resumed paper rejoins the same run. */
  key?: string
  submittedAt?: string
  finishedAt?: string
  error?: string
  /** The finished research bundle, saved in the paper folder. */
  bundle?: string
  searchedOn?: string
  models?: { research: string; audit: string }
  protocol?: { concepts: string[]; eligibility: { core: string; supporting: string; exclusion: string }; queries: string[] }
  counts?: { discovered: number; screened: number; retrieved: number; reviewed: number; core: number; supporting: number; cited: number; queries: number; findings: number; audited: number; minutes: number }
  gaps?: string[]
  contradictions?: string[]
  /** The ledger claims the review contributed. */
  claimIds?: string[]
}

export interface PaperState {
  version: 1
  slug: string
  createdAt: string
  seed: { text: string; sha256: string }
  brief?: Brief
  claims: Claim[]
  positioning: Positioning
  ideaReview?: IdeaReview
  directions: Direction[]
  selectedDirection?: { id: string; reason: string }
  plan?: Plan
  works: Record<string, Work>
  candidates: Candidate[]
  citations: Citation[]
  outline?: { sections: Section[]; style: string; glossary: string[] }
  passages: Record<string, Passage>
  figures: Figure[]
  frame?: Frame
  findings: Finding[]
  round: number
  calibration?: Calibration
  /** What galley computed in the authors' datasets, by analysis id (A1, A2 …). */
  measurements?: Record<string, import('./materials.js').Measurement>
  /** The systematic review of the literature, when the paper has one. */
  literature?: LiteratureReview
  profileAfter?: IdeaReview
  /** Behavior targets that are settled: done, skipped, or exhausted. */
  settled: Record<string, 'done' | 'skipped'>
  attempts: Record<string, number>
  notes: Note[]
  choices?: Record<string, Choice>
  proposals?: Proposal[]
  /** The text galley last wrote to the editor, per section, to tell a person's edits from its own. */
  editorBase?: Record<string, string>
  outcome?: Outcome
}
