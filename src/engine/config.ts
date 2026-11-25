// Who plays which seat, and the dials a paper can turn. A paper's paper.json
// overrides any of these; nothing else does.
import { LEGACY_MODELS, LEGACY_LIGHT_MODELS, modelSpec, type ModelRouting } from './model-catalog.js'
import type { SoftwareRole } from '../core/software-subject.js'
import type { DatasetUnit, Material } from './materials.js'
import type { ModelSpec } from './models.js'
import type { Family, Seat } from './types.js'
import type { WorldModelConfig } from './worldmodel.js'

export const FAMILY_NAMES: Record<Family, string> = {
  claude: 'Claude Opus 5.5',
  gpt: 'GPT-6.2 Sol',
  gemini: 'Gemini 4 Carbon',
}

const LIGHT_NAMES: Record<string, string> = {
  [LEGACY_MODELS.claude.selector]: FAMILY_NAMES.claude,
  [LEGACY_MODELS.gpt.selector]: FAMILY_NAMES.gpt,
  [LEGACY_LIGHT_MODELS.gemini.selector]: 'Gemini 4 Hydrogen',
  [LEGACY_MODELS.gemini.selector]: FAMILY_NAMES.gemini,
}

export function lightName(spec: ModelSpec): string {
  const name = LIGHT_NAMES[spec.model] ?? spec.model
  return spec.family === 'gemini' ? name : `${name} at ${spec.effort} effort`
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

/** One pipeline, two branches: a paper, or a thesis that can become one later. */
export type Mode = 'paper' | 'thesis'
/** Extend builds on what the field holds, contest goes against it, reframe goes beyond it onto another axis. */
export type Stance = 'extend' | 'contest' | 'reframe'

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
  routing?: ModelRouting
  models: Partial<Record<Family, { model: string; effort: string }>>
  /** The lighter settings that answer, judge and settle single referee findings; defaults to LIGHT_MODELS. */
  lightModels?: Partial<Record<Family, { model: string; effort: string }>>
  /** Behaviors switched off for this paper. */
  off: string[]
  /**
   * Append the claim ledger (every claim, its standing and its sources) to the manuscript. Default false: a claim's
   * standing is the authors' to see beside the text and in the evidence package, not the paper's to print.
   */
  ledgerAppendix?: boolean
  /** Where the manuscript's editor document goes; defaults to the paper's own editor/ folder. */
  editorDir?: string
  /** The editor document the paper is written into, by its exact name: the document the project started from. Defaults to the folder's name. */
  editorDoc?: string
  /** Statements only the authors can make; each one left empty is a sign-off item. */
  declarations?: { availability?: string; competing_interests?: string; funding?: string; acknowledgements?: string }
  /** The datasets, documents and links the paper draws on, copied into the paper's materials folder when it starts. */
  materials?: Material[]
  /** Datasets as units: each one's files (as materials) under one name, with where the data comes from. */
  datasets?: DatasetUnit[]
  /**
   * Look on the web for the primary document a claim rests on (the issuer's own rules, standards, specifications,
   * datasheets or reports) when the scholarly index has no source for it. On unless set to false.
   */
  webSources?: boolean
  /**
   * A Resolvent world model the paper's sources come from: only its sources (the default), or its sources first and then
   * the literature and the web. See worldmodel.ts.
   */
  worldModel?: WorldModelConfig
  /** What the run makes: a paper (the default), or a thesis, formulated from the seed and the literature and handed back as a brief. */
  mode?: Mode
  /** A thesis's stance toward what the field holds: build on it, contest it, or reframe it. */
  stance?: Stance
  softwareCommit?: string
  softwareRole?: SoftwareRole
  /** Include a literature review, run by Canary: as its own section, or (load-bearing) as the paper's main contribution. */
  literatureReview?: boolean | 'load-bearing'
  /** Include a Monte Carlo simulation the author designs and galley runs on this machine: in support, or (load-bearing) as what the main contribution rests on. */
  simulation?: boolean | 'load-bearing'
  /**
   * The model families this paper may use; all three unless set. A family that is off hands its seats on: the author's
   * seat goes to the first family on (Claude, GPT, Gemini), and every checking seat to a family other than the author's.
   */
  families?: Family[]
}

export const FAMILIES: Family[] = ['claude', 'gpt', 'gemini']

/** The families a paper may use, in the order the author's seat prefers them. */
export const familiesOn = (config: Pick<PaperConfig, 'families'>): Family[] => FAMILIES.filter((f) => (config.families ?? FAMILIES).includes(f))

/**
 * Seats for the families that are on. The author keeps its family if it is on, else the first family on writes; every
 * seat that checks the author's work (checker, challenger, verifier, the referees) keeps its family if that is on and
 * is not the author's, else goes to a family that is, so no family ever checks its own writing.
 */
export function applyFamilies<T extends Pick<PaperConfig, 'families' | 'seats' | 'referees'>>(config: T): T {
  const on = familiesOn(config)
  if (on.length < 2) throw new Error('a paper needs at least two model families: one writes, another checks')
  const author = on.includes(config.seats.author) ? config.seats.author : on[0]
  const away = (f: Family) => f !== author && on.includes(f) ? f : on.find((x) => x !== author)!
  return {
    ...config,
    seats: { author, checker: away(config.seats.checker), challenger: away(config.seats.challenger), verifier: away(config.seats.verifier) },
    referees: config.referees.map((r) => ({ ...r, family: away(r.family) })),
  }
}

/** The family that settles a dispute between the author and a referee: one that is neither, among those on; none when only two are on. */
export function adjudicatorFor(config: Pick<PaperConfig, 'families'>, author: Family, raising: Family): Family | null {
  return familiesOn(config).find((f) => f !== author && f !== raising) ?? null
}

export const DEFAULT_REFEREES: RefereeSeat[] = [
  {
    seat: 'methods',
    family: 'gpt',
    brief: 'You are the methods referee. Judge whether every claim is supported by the evidence the paper gives, whether the argument follows, '
      + 'which conclusions overreach, and which limitations are missing. A skeptical expert must be able to accept each load-bearing claim. '
      + 'Compare every statement the paper makes about its data and analyses with the analysis records given with it (the measurements and their '
      + 'assumption checks): a statement a record contradicts, where the paper does not say why it reads the record differently, is a material finding.',
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
  const chosen = config.models[family]
  return chosen ? { family, ...chosen } : modelSpec(LEGACY_MODELS[family])
}

export function lightSpecFor(config: PaperConfig, family: Family): ModelSpec {
  const chosen = config.lightModels?.[family]
  return chosen ? { family, ...chosen } : modelSpec(LEGACY_LIGHT_MODELS[family])
}
