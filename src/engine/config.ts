// Who plays which seat, and the dials a paper can turn. A paper's paper.json
// overrides any of these; nothing else does.
import type { Material } from './materials.js'
import type { ModelSpec } from './models.js'
import type { Family, Seat } from './types.js'

export const FAMILY_MODELS: Record<Family, { model: string; effort: string }> = {
  claude: { model: 'claude-opus-5-5', effort: 'xhigh' },
  gpt: { model: 'gpt-6.2-sol', effort: 'xhigh' },
  // Antigravity names the effort in the model id.
  gemini: { model: 'gemini-4-carbon-high', effort: 'high' },
}

export const FAMILY_NAMES: Record<Family, string> = {
  claude: 'Claude Opus 5.5',
  gpt: 'GPT-6.2 Sol',
  gemini: 'Gemini 4 Carbon',
}

export interface RefereeSeat {
  seat: string
  family: Family
  brief: string
}

export interface Author {
  name: string
  affiliation?: string
  email?: string
  orcid?: string
}

export interface PaperConfig {
  /** Overrides the title the system chooses. */
  title?: string
  /** Filled into the byline at typesetting only; never sent to a model. */
  authors: Author[]
  venue: string
  words: number
  /** Typst bibliography style name, used for the PDF. */
  citationStyle: string
  /** autonomous: defaults decide; assisted: load-bearing citations and answers to critical findings wait for you; propose: no answer to a referee changes the text without your Accept. */
  dial: 'autonomous' | 'assisted' | 'propose'
  citations: 'auto' | 'choose' | 'mixed'
  rounds: number
  fixAttempts: number
  candidatesPerClaim: number
  seats: Record<Exclude<Seat, 'referee' | 'adjudicator'>, Family>
  referees: RefereeSeat[]
  models: Partial<Record<Family, { model: string; effort: string }>>
  /** Behaviors switched off for this paper. */
  off: string[]
  /** Append the claim ledger (every claim, its standing and its sources) to the manuscript. Default true. */
  ledgerAppendix?: boolean
  /** Where the manuscript's editor document goes; defaults to the paper's own editor/ folder. */
  editorDir?: string
  /** Statements only the authors can make; each one left empty is a sign-off item. */
  declarations?: { availability?: string; competing_interests?: string; funding?: string }
  /** The authors' own datasets, documents and links, copied into the paper's materials folder when it starts. */
  materials?: Material[]
  /** Include a systematic review of the literature, run by Canary: as its own section, or (load-bearing) as the paper's main contribution. */
  literatureReview?: boolean | 'load-bearing'
  /** Include a Monte Carlo simulation the author designs and galley runs on this machine: in support, or (load-bearing) as what the main contribution rests on. */
  simulation?: boolean | 'load-bearing'
}

export const DEFAULT_REFEREES: RefereeSeat[] = [
  {
    seat: 'methods',
    family: 'gpt',
    brief: 'You are the methods referee. Judge whether every claim is supported by the evidence the paper gives, whether the argument follows, '
      + 'which conclusions overreach, and which limitations are missing. A skeptical expert must be able to accept each load-bearing claim.',
  },
  {
    seat: 'field',
    family: 'gemini',
    brief: 'You are a referee from inside the host field. Judge whether the paper engages the field correctly: its terms, the prior work a specialist '
      + 'expects, how the contribution is positioned, and whether specialists would build on it.',
  },
  {
    seat: 'citations',
    family: 'gpt',
    brief: 'You are the citations and prior-art referee. Check each citation against the passage it rests on, flag misattribution and overreach, '
      + 'and name missing priority work that a reader in this area would expect to see cited (only works you are confident exist).',
  },
  {
    seat: 'editor',
    family: 'gemini',
    brief: 'You are the desk editor and an intelligent outsider. Judge clarity, structure, the title and abstract, length and redundancy, and whether '
      + 'the contribution is plain on the first page. Decide whether you would send this to review.',
  },
]

export function defaultConfig(): PaperConfig {
  return {
    authors: [],
    venue: 'preprint (arXiv)',
    words: 7000,
    citationStyle: 'apa',
    dial: 'autonomous',
    citations: 'auto',
    rounds: 2,
    fixAttempts: 3,
    candidatesPerClaim: 10,
    seats: { author: 'claude', checker: 'gpt', challenger: 'gemini', verifier: 'gemini' },
    referees: DEFAULT_REFEREES,
    models: {},
    off: [],
  }
}

export function specFor(config: PaperConfig, family: Family): ModelSpec {
  const chosen = config.models[family] ?? FAMILY_MODELS[family]
  return { family, model: chosen.model, effort: chosen.effort }
}

/** The family that is neither of the two given: the third voice for adjudication. */
export function thirdFamily(...taken: Family[]): Family {
  const families: Family[] = ['claude', 'gpt', 'gemini']
  return families.find((f) => !taken.includes(f)) ?? families.find((f) => f !== taken[0])!
}
