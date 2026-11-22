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
  /** Looked up once by its title, to complete a reference that had only its title, year and link. */
  titleChecked?: boolean
  /** The kind of publication the index gives it (a CSL type), for a work with no DOI record to say so. */
  kind?: string
  /** The institution its first author wrote it at, as the index names it: where a thesis was written. */
  institution?: string
  /** What a reader of the typeset paper corrected in its citation record, as "set field" or "remove field". */
  corrected?: string[]
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
  /** limitations: the paper's one statement of the limits of its work, written when the paper is told and printed after the conclusion. */
  role?: 'limitations'
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
  /** A defect a reader found in the typeset figure, for the next drawing to fix. */
  revise?: string
  /** How many times a reader sent it back: each drawing again is a step of its own. */
  redraws?: number
  /** chart: drawn by Astetik from the paper's own records; otherwise a drawing in Typst. */
  kind?: 'drawing' | 'chart'
  chart?: ChartPlan
}

/** One panel of a chart: its kind, and the data it draws by reference to the paper's own records, never as typed numbers. */
export interface ChartPanel {
  kind: 'hist' | 'line' | 'interval'
  /** sim:<run>:<output> (the run's draws, or one estimate with its interval), steps:<run>:<output> (a band over time), data:<measurement id>. */
  data: string[]
  /** What each reference is called in the legend or as its row, in the same order. */
  labels: string[]
  /** The axis labels, as the paper names the quantities. */
  x: string
  y: string
  /** The unit of the measured quantity, as the paper writes it ("1" for none). */
  unit: string
  /** The unit of a line chart's horizontal axis (time, a setting). */
  xUnit?: string
  /** What the series differ by, as the paper names it ("Run", "Setting"): it heads the panels or the legend. */
  group?: string
  /** Thin reference lines at values the text states. */
  marks: { axis: 'x' | 'y'; value: number; label: string }[]
}

/** A chart galley draws through Astetik: what the reader should see, and the panels that show it. */
export interface ChartPlan {
  purpose: string
  panels: ChartPanel[]
  /** The figure it replaces, whose number it keeps. */
  replaces?: string
  /** The Astetik evidence bundle of its current drawing, in the paper's build folder. */
  bundle?: string
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
  /** unanswered: an attempt that gave no answer; it still counts, so the finding moves on to adjudication. */
  kind: 'fixed' | 'rebutted' | 'limitation' | 'needs_evidence' | 'unanswered'
  text: string
  edits: { old: string; new: string }[]
  family: Family
  /** rechecked: judged a second time at full effort, after a first verdict that could not tell. */
  verification?: { outcome: 'verified' | 'disagrees' | 'uncertain'; reason: string; family: Family; rechecked?: boolean }
}

export interface Finding {
  id: string
  /** When it was raised. */
  at?: string
  /** A finding raised as an answer in another finding's thread: a person replying in the editor. */
  parent?: string
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
  /**
   * How a third family settled it. setAside: the referee's point was judged not to hold, and handledBy is the
   * sentence of the text that answers it. fallback: adjudication could not settle it in the text, so the paper
   * states it as a limitation.
   */
  adjudication?: { decision: string; family: Family; edits: { old: string; new: string }[]; setAside?: boolean; handledBy?: string; fallback?: boolean }
}

export interface Note {
  at: string
  behavior: string
  text: string
  /** Shown on the sign-off sheet as something the person decides. */
  forHuman?: boolean
}

/**
 * What an agent wants the authors to know about a passage, kept beside the text as a comment in the editor and never
 * printed: a claim with no verified source, a limit of the work, a doubt, a caution. The paper states its work plainly;
 * the caution stays where the authors see it.
 */
export interface AuthorNote {
  id: string
  sectionId: string | null
  /** The words of the text it concerns, copied exactly; empty for a note on the section as a whole. */
  quote: string
  text: string
  kind: 'unverified' | 'limitation' | 'caution'
  seat: Seat
  family: Family
  behavior: string
  at: string
}

export interface Calibration {
  planted: number
  caught: number
  details: { kind: string; caught: boolean; family: Family }[]
}

export type Outcome = 'ready_for_submission' | 'no_subject' | 'no_contribution' | 'thesis_not_supported' | 'thesis_ready'

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
  counts?: { discovered: number; screened: number; retrieved: number; reviewed: number; core: number; supporting: number; cited: number; queries: number; findings: number; audited: number; minutes: number; excludedScreening?: number; excludedFullText?: number }
  gaps?: string[]
  contradictions?: string[]
  /** Every publication the review read in full and included, cited or not, with its role and why it was included. */
  included?: { workId: string; role: 'core' | 'supporting'; reason: string }[]
  /** Why the search stopped where it did, as Canary recorded it. */
  stopping?: string
  /** What the review cannot claim: its source, the access it had, who screened and when it stopped. */
  limits?: string[]
  /** The ledger claims the review contributed. */
  claimIds?: string[]
}

/** One planned analysis of the authors' data: what it asks, how, with what uncertainty, and how its assumptions are checked. */
export interface PlannedAnalysis {
  id: string
  claims: string[]
  question: string
  method: string
  uncertainty: string
  assumptions: string[]
  checks: string[]
  datasets: string[]
}

export interface DataAnalysis {
  field: string
  conventions: string[]
  preparation: string[]
  plan: PlannedAnalysis[]
  /** code: the analyses ran as code in the sandbox; operations: galley's built-in operations measured instead. */
  mode: 'code' | 'operations'
  reviewed?: { family: Family; notes: string[] }
  runs?: Record<string, { ok: boolean; code: string; results: { name: string; value: number; unit?: string; n?: number; count?: number; ci_low?: number; ci_high?: number; ci_level?: number; method: string }[]; checks: { assumption: string; method: string; statistic?: number; p?: number; holds: boolean; note: string }[]; error?: string; attempts: number; ms: number }>
  /** The shared preparation every analysis starts from: its code, and what it reported (each step with the rows it kept, and the shared definitions). */
  prepare?: { ok: boolean; code: string; report?: { steps: { step: string; rows_before?: number; rows_after?: number; note: string }[]; definitions: string[] }; error?: string }
  /** Planned analyses that did not run: the paper never describes them. */
  notComputed?: { id: string; question: string; why: string }[]
  /** What the analyses took from a database: each extract's SQL, run read-only by galley, and the table it made. */
  extracts?: { id: string; database: string; purpose: string; sql: string; ok: boolean; rows?: number; material?: string; sha256?: string; error?: string; ms?: number }[]
  /** The Python and package versions the analyses ran on. */
  environment?: Record<string, string>
}

/** A printing defect found in the typeset paper: by the reader (a model reading the pages) or by the mechanical check. */
export interface ProofDefect {
  page: number | null
  where: 'section text' | 'figure' | 'table' | 'equation' | 'references' | 'front matter' | 'appendix' | 'other'
  quote: string
  problem: string
  fix: string
  by: 'reader' | 'check'
  /** The figure it was found in, when the check read that figure's own source. */
  figureId?: string
}

/** One position the field holds, as the literature shows it: what it holds and the assumption it rests on. */
export interface ThesisPosition { name: string; holds: string; restsOn: string; sources: string[] }

/** A condition the thesis holds under, marked by what supports it: the seed gives it, the thesis assumes it, a source supports it, or nobody knows yet. */
export interface ThesisCondition { statement: string; status: 'given' | 'assumed' | 'supported' | 'unknown'; sources: string[] }

/** A thesis formulated from the seed and the literature, from one stance toward what the field holds. */
export interface Thesis {
  stance: import('./config.js').Stance
  statement: string
  title: string
  /** How it stands to the positions: which it builds on, contests or leaves for another axis, and why. */
  relation: string
  positions: ThesisPosition[]
  /** An assumption every position shares and none examines; empty when there is none. */
  sharedAssumption: string
  /** For a reframe: the first idea that formed, named and set aside so the thesis is not merely its opposite. */
  setAside: string
  conditions: ThesisCondition[]
  /** What the thesis depends on that it does not contain: the conditions under which it stops holding. */
  dependsOn: string[]
  /** What would decide it: the observation, comparison or argument that would settle it. */
  decides: string
  /** What a good answer would let someone understand, investigate or stop doing. */
  opens: string
  /** The tension the thesis leaves unresolved; empty when none is apparent. */
  residue: string
  /** Searches that would find work already stating it. */
  noveltyQueries: string[]
  revision: number
  /** The test for its stance, by a family other than the author's. */
  test?: {
    passes: boolean; objections: string[]; already: string[]; family: string; revisedFrom?: string
    /** The closest work the search found, and how the thesis differs from each: what its novelty was checked against. */
    closest?: { title: string; year: number | null; doi: string | null; differs: string }[]
    /** How many works the search for work already stating the thesis found; null when no search ran. */
    searched?: number | null
  }
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
  /** The literature review, when the paper has one. */
  literature?: LiteratureReview
  /** The thesis, when the run makes one instead of a paper. */
  thesis?: Thesis
  /** The Monte Carlo simulations galley ran for the paper, by id (S1 …). */
  simulations?: Record<string, import('./simulations.js').SimulationRun>
  profileAfter?: IdeaReview
  /** Behavior targets that are settled: done, skipped, or exhausted. */
  settled: Record<string, 'done' | 'skipped'>
  attempts: Record<string, number>
  notes: Note[]
  /** Comments for the authors beside the text: the caution agents keep out of the paper. */
  authorNotes?: AuthorNote[]
  choices?: Record<string, Choice>
  proposals?: Proposal[]
  /** The text galley last wrote to the editor, per section, to tell a person's edits from its own. */
  editorBase?: Record<string, string>
  /** Hashes of the document and notes galley last wrote, so a person's change is noticed without a diff. */
  editorWritten?: { doc: string; notes: string }
  /** Threads galley itself last wrote as resolved, so its own mark is never taken for a person's decision. */
  editorResolved?: string[]
  /** The typeset review: how many readings, what the last one found, how many defects were fixed and what is left for a person. */
  proof?: { rounds: number; hash: string; defects: ProofDefect[]; fixed: number; left: ProofDefect[] }
  /** Works the text names, cited where they are named (placed), or listed without a place when the quote was not found. */
  named?: { workId: string; quote: string; sectionId: string; placed: boolean }[]
  /** Names of works the text gives that no source could be found for: on the sign-off sheet. */
  unreferenced?: { quote: string; sectionId: string }[]
  /** The analysis of the authors' data: the field's conventions, the preparation, the reviewed plan, and what each analysis's code printed. */
  analysis?: DataAnalysis
  /** Replies a person wrote in the editor that are already findings. */
  repliesSeen?: string[]
  /** A title a person gave the paper in the editor; it stands over the system's. */
  titleByHuman?: string
  outcome?: Outcome
}
