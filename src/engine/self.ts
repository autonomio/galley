// What galley knows about itself. A paper about the system that produces it
// describes the system as it actually is: the ladder this run executes, its
// seats and settings, and the rules the code enforces. Generated from the
// running configuration for every paper, never written for one.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAMILY_NAMES, specFor } from './config.js'
import type { Paper } from './paper.js'
import type { Family } from './types.js'

/** What each behavior does, as `galley ladder` prints it. */
export const DOES: Record<string, string> = {
  extract: "reads the seed and lists its claims, the concern behind them, the contribution it states and its host field",
  position: "writes searches and reads what they find to place the idea: its closest prior work, the shared bottleneck and the field's consensus",
  'review-idea': 'scores the idea on the seven impact factors before anything is written, names the weakest and gives a verdict: worth writing, reformulate, or no contribution',
  reformulate: 'when the idea should be reframed, proposes exactly three structurally different directions that keep the seed\'s explicit commitments',
  'select-direction': 'chooses the original idea or one direction; never the family that proposed the directions',
  plan: "sets the thesis, the paper's noun and the full claim graph, each claim marked as needing external evidence, the authors' own work, or a premise",
  outline: 'sections with word budgets and their claims, planned figures, the style sheet and a glossary',
  'find-evidence': "writes literature searches for each claim that needs evidence, runs them through Canary's search over OpenAlex, and selects candidate passages copied verbatim from the abstracts found",
  verify: 'judges each candidate passage against its claim: supported, narrower (the claim is narrowed to what the passage states) or not supported (the citation is rejected and the next candidate is tried)',
  reassess: 'when a load-bearing claim ends without evidence, decides whether the thesis stands, narrows or fails',
  calibrate: 'plants defective citations and unaltered controls among the verified ones and measures how many the verifier catches',
  draft: 'writes each section once its evidence is settled, citing only verified passages and stating claims without evidence as hypotheses',
  figure: 'draws each planned figure in Typst and compiles it',
  fidelity: 'checks every drafted section against its claims and fixes sentences that say more than their evidence',
  frame: 'writes the title, abstract and keywords once every section is checked, and again from the reviewed text',
  referee: 'referee seats for methods, the host field, citations and the desk editor review the whole manuscript and raise findings with a severity and the decision they ask for',
  'close-round': 'ends a referee round once every seat has reported',
  respond: 'the author answers each material finding: fixed with exact edits, rebutted, stated as a limitation, or needs evidence (a new claim that goes through search and verification before the author answers again)',
  'verify-disposition': 'the referee who raised a finding judges the answer to it',
  adjudicate: 'a third family settles a finding still disputed after the attempt cap',
  reconcile: "once review is done, a family other than the author's reads the final text against every claim in the ledger: each is confirmed, narrowed to the text's wording, or dropped as no longer stated, so the ledger, the evidence package and the sign-off sheet say what the manuscript says",
  reprofile: 'scores the finished paper against the seven impact factors',
  typeset: 'whenever the text changes, renders the PDF, a line-numbered review PDF, LaTeX, Word, the editor document, the evidence package and the sign-off sheet',
  ready: 'marks the paper ready for submission once every gate holds on one revision',
}

const RULES = [
  'The skeleton (the required behaviors) makes a paper exist; every other behavior is an improver that can make it better but never stop it. An improver that fails twice is skipped and its effect is written down: a claim without evidence is hedged, a figure is left out. A model provider that hits a usage limit is waited out for up to about six hours without counting a failure (only a longer limit pauses the run, resumably); a search index that is unavailable is waited for up to three hours, after which the search is given up and its claims hedged.',
  'Behaviors are atomic: each reads the paper\'s state, does one thing and writes its result. The scheduler scans the ladder from the top, runs whatever is ready, and scans again from the top after anything settles; no behavior knows what comes next.',
  'Each model family runs through its own command-line client with no tools and no delegation, answering in a strict JSON schema. Every prompt and answer is stored in the paper\'s folder, and a rerun replays them without calling a model.',
  'No family reviews its own work. A citation rests on a passage that code confirms is copied verbatim from the cited work\'s abstract; the checker proposes it and the verifier, another family, judges it. A cited work with a DOI takes its bibliographic record from the DOI registry.',
  'Every manuscript ends with its claim ledger (every claim, its kind, its standing, whether the seed or the system made it, and its sources) and a statement of how it was produced with a production record generated from the run\'s journal. The run also writes a sign-off sheet of what only the authors can decide (declarations, claims the system added, claims stated as hypotheses, decisions a third family made, skipped steps), an evidence package of claims, evidence and sources in the Resolvent format, and the production journal itself.',
  'A person can be in the loop at any point without being required: edits made in the editor become their revision on the next run; a comment becomes a thread that the agents take over by default, the person keeps (@humans) or both share (@both, as proposed changes they accept or decline); with citation choices on, each claim waits for the person to pick among its candidate sources (a, b, c), let the system pick, or state it without a source; the dial makes load-bearing citations and critical answers, or every answer, wait for the person.',
]

interface Package { name?: string; version?: string; license?: string; repository?: string | { url?: string } }

function packageInfo(): Package {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as Package
  } catch {
    return {}
  }
}

function repositoryUrl(pkg: Package): string | null {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return raw ? raw.replace(/^git\+/, '').replace(/\.git$/, '') : null
}

/** The software that produced a manuscript, as its production statement names it: "galley 0.1.0 (MIT licence, https://…)". */
export function software(): string {
  const pkg = packageInfo()
  const repo = repositoryUrl(pkg)
  const details = [pkg.license ? `${pkg.license} licence` : '', repo ?? ''].filter(Boolean).join(', ')
  return `galley${pkg.version ? ` ${pkg.version}` : ''}${details ? ` (${details})` : ''}`
}

/** Where galley's source is, for the availability statement of a paper about galley itself. */
export function sourceStatement(): string {
  const pkg = packageInfo()
  const repo = repositoryUrl(pkg)
  if (!repo) return ''
  return `galley's source code, including the behaviors that produced this manuscript, is available${pkg.license ? ` under the ${pkg.license} licence` : ''} at ${repo}.`
}

/** The system description, for every seat that writes or judges a manuscript about galley itself. Empty for any other paper, and outside a run. */
export function systemBlock(paper: Paper): string {
  const ladder = paper.ladder
  if (!ladder.length || !paper.state.brief?.aboutSystem) return ''
  const c = paper.config
  const who = (family: Family) => `${FAMILY_NAMES[family]} (${specFor(c, family).model})`
  const pkg = packageInfo()
  const repo = repositoryUrl(pkg)
  const dial = { autonomous: 'autonomous (no step waits for a person)', assisted: 'assisted (load-bearing citations and answers to critical findings wait for a person)', propose: 'propose (every answer to a referee waits for a person to accept it)' }[c.dial]
  return [
    'THE SYSTEM THIS MANUSCRIPT IS ABOUT, WHICH IS ALSO PRODUCING IT. Generated from galley\'s own ladder, seats and package metadata for this run, so it is accurate; it is not part of the seed. What the manuscript says about how galley works rests on this, stated as the authors\' own work; the seed says what the paper is and argues. The numbers of this run are in the production record (the run.* placeholders) and in a generated section of the manuscript.',
    pkg.name ? `Package: ${pkg.name}${pkg.version ? ` ${pkg.version}` : ''}${pkg.license ? `, ${pkg.license} licence` : ''}${repo ? `, source at ${repo}` : ''}.` : '',
    `Seats in this run: author ${who(c.seats.author)}; checker ${who(c.seats.checker)}; challenger ${who(c.seats.challenger)}; verifier ${who(c.seats.verifier)}; referees: ${c.referees.map((r) => r.seat).join(', ')} seats, drawn from the families other than the author's and rotated between rounds; adjudicator: the family that is neither the author's nor the referee's.`,
    `Settings in this run: dial ${dial}; citations ${c.citations}; ${c.rounds} referee round(s); up to ${c.fixAttempts} answers per finding before adjudication; up to ${c.candidatesPerClaim} candidate works per claim; about ${c.words} words; venue ${c.venue}.`,
    `The ladder (${ladder.length} behaviors, scanned in this order):`,
    ...ladder.map((b, i) => `${i + 1}. ${b.id} (${b.stage}, ${b.improver ? 'improver' : 'required'}): ${DOES[b.id] ?? b.title}`),
    'Rules the code enforces:',
    ...RULES.map((rule) => `- ${rule}`),
  ].filter(Boolean).join('\n')
}
