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
  'literature-review': "when the authors ask for one, the author writes a review question and Canary carries out a systematic review in the background: a research model plans the search of OpenAlex, screens the candidates, reads the full texts and quotes the passages behind each finding, and an independent model audits every finding; the upheld findings join the claim ledger with their passages as verified citations and fill the paper's review section",
  analyze: "the reviewed plan runs as Python on the authors' machine, in a sandbox with no network that writes only to its own folder; every number the paper states about the data is filled in from what the code printed, with its interval and its n, and an analysis that did not run is never described (without a Python and a sandbox, galley's built-in operations measure instead)",
  simulate: "when the authors ask for one, the author designs the Monte Carlo simulation the argument needs (plain, correlated or sequential), with the basis of every input's distribution, and galley runs it on the authors' machine; the engine's problems go back to the author until the specification runs, the argument is planned from the results, and every simulated number in the text is a placeholder filled from the run at the precision its Monte Carlo error supports",
  plan: "sets the thesis, the paper's noun and the full claim graph, each claim marked as needing external evidence, the authors' own work, or a premise",
  outline: 'sections with word budgets and their claims, planned figures, the style sheet and a glossary',
  'find-evidence': "writes literature searches for each claim that needs evidence, runs them through Canary's search over OpenAlex, and selects candidate passages copied verbatim from the abstracts found; a paper built on a Resolvent world model searches that world model's sources instead (only them, by default, or them first) and copies the passages from their excerpts",
  verify: 'judges each candidate passage against its claim: supported, narrower (the claim is narrowed to what the passage states) or not supported (the citation is rejected and the next candidate is tried)',
  reassess: 'when a load-bearing claim ends without evidence, decides whether the thesis stands, narrows or fails',
  calibrate: 'plants defective citations and unaltered controls among the verified ones and measures how many the verifier catches',
  draft: 'writes each section once its evidence is settled, citing only verified passages; the text states its claims plainly, and what the authors should know about a passage (a claim with no verified source, a limit, a doubt) goes beside it as a comment in the editor, never into the paper',
  figure: 'draws each planned figure in Typst and compiles it',
  fidelity: 'checks every drafted section against its claims and fixes sentences that say more than their evidence by stating what it supports, never by adding a hedge',
  frame: 'writes the title, abstract and keywords once every section is checked, and again from the reviewed text',
  referee: 'referee seats for methods, the host field, citations and the desk editor review the whole manuscript and raise findings with a severity and the decision they ask for',
  'close-round': 'ends a referee round once every seat has reported',
  respond: 'the author answers each finding: fixed with exact edits, rebutted, answered as a limitation left for the authors beside the text (the paper is not edited), or needs evidence (a new claim that goes through search and verification before the author answers again); a first answer runs on lighter settings, and once a referee rejects one the author answers at full effort',
  'analysis-plan': "with the authors' data, the author plans its analysis to the standard of its field: the field's conventions for preparing and reporting such data, the preparation steps, and each analysis with its method, how its uncertainty is computed, and how its assumptions are checked",
  'extract-data': "with a database, the author writes the extracts the reviewed plan needs as read-only ClickHouse queries that aggregate in the database; galley runs each under its limits (read-only, bounded in time and rows) and each table it returns becomes a private dataset; the queries go into the evidence package",
  'analysis-review': "a statistician from another family reviews the analysis plan before anything runs: adds the field's requirements it misses, gives every estimate its n and a valid interval, checks every assumption, and cuts what the data cannot answer",
  'web-sources': "for a claim the scholarly index has no source for, GPT searches the web for the primary document (the issuer's own rules, standards, specifications, datasheets or reports); galley fetches and keeps a copy of each, the checker copies the exact passage, and the passage goes to verification by another family like any citation",
  'verify-disposition': 'the referee who raised a finding judges the answer to it; a verdict that cannot tell is asked again at full effort, and one that still cannot tell sends the answer back',
  adjudicate: 'a third family settles, at full effort, a finding still disputed after the attempt cap; every decision lands in the text, and a finding it sets aside still gets the sentence that answers it',
  'handle-finding': 'leaves any finding adjudication could not settle for the authors, as a comment beside the text, so no finding is left unanswered; where it is a limit of the work, the told paper states it in its Limitations section',
  'cite-named': "once review is done, the checker reads the text for every publication, standard or dataset it names by author and year or by its own designation without citing it, and picks the work it names from those the paper holds or, where the paper may search beyond its world model, from the scholarly index's candidates for its first author and year, judged by the sentence it is named in; each is cited where it is named, and a name no source is found for is left as written and listed on the sign-off sheet",
  'story-caveats': "once review is done, the research is told without being changed: the author gathers every caveat (an assumption that may not hold, a case left untested, a limit on how far a result reaches) from the sections and captions into one Limitations section, printed after the conclusion, with the limits left for the authors during review; what a result is about stays where the paper defines it, stated once",
  'story-lead': "the author rewrites the opening of the introduction to state the paper's main findings first, plainly and with their key numbers, and titles the paper so a reader in the field understands it without reading it",
  'story-example': "the author works one concrete case through the paper's method, step by step, with the paper's own numbers; every number it works out is listed with its arithmetic, and code checks each one",
  'story-register': 'the author makes the paper read as one author wrote it: one register, one voice, one name for each concept, one way of doing the same thing',
  'story-charts': "the author picks the parts of the paper that gain most from a chart (a distribution, a course with its band, or estimates with their intervals, alone or in a grid) and names the data by reference; galley writes the data from its own records (a simulation's draws, made again from its seed, or the analysis's printed estimates) and Astetik draws them from a declared specification into a verified evidence bundle, so no number in a chart is typed by a model",
  'story-read': "after the final frame, families other than the author's read the whole paper through three times, as a reader meets it, for unnecessary complication, incoherence and tension; the author cleans up each place. Every story step's change is checked by code (no citation, recorded number, numbered statement, table or equation the paper holds is lost, and none is added) and by a family other than the author's against what the text was; a change that fails either is undone",
  copyedit: "once the named works are cited, a family other than the author's reads the whole text once as a copyeditor, for what no single section shows: a definition, count or quantity stated two ways (a caption included), a statement a later passage contradicts, a symbol with two meanings or renamed partway, a passage given twice, a stranded sentence, a citation used as a noun, labels written two ways; the author fixes each with exact edits",
  reconcile: "once review is done, a family other than the author's reads the final text against every claim in the ledger: each is confirmed, narrowed to the text's wording, or dropped as no longer stated, so the ledger, the evidence package and the sign-off sheet say what the manuscript says",
  reprofile: 'scores the finished paper against the seven impact factors',
  typeset: 'whenever the text changes, renders the PDF, a line-numbered review PDF, LaTeX, Word, the editor document, the evidence package and the sign-off sheet',
  proof: "once the paper is typeset, a family other than the author's reads every printed page, as an image where it can see one and as text in any case, with checks for what must never be printed (placeholders, raw labels, unresolved references, blanks); defects in the prose go back to the author and defects in a figure go back to the figure, then the paper is typeset and read again",
  ready: 'marks the paper ready for submission once every gate holds on one revision, the typeset reading included',
}

const RULES = [
  'The skeleton (the required behaviors) makes a paper exist; every other behavior is an improver that makes it better without being able to stop it.',
  'Behaviors are atomic: each reads the paper\'s state, does one thing and writes its result. The scheduler scans the ladder from the top, runs whatever is ready, and scans again from the top after anything settles; no behavior knows what comes next.',
  'Each model family runs through its own command-line client with no tools and no delegation, answering in a strict JSON schema. Every prompt and answer is stored in the paper\'s folder, and a rerun replays them without calling a model.',
  'No family reviews its own work. A citation rests on a passage that code confirms is copied verbatim from the cited work\'s abstract; the checker proposes it and the verifier, another family, judges it. A cited work with a DOI takes its bibliographic record from the DOI registry.',
  'Every manuscript ends with a statement of how it was produced, with a production record generated from the run\'s journal. The paper states its work plainly: every caution the agents keep (a claim with no verified source, a limit of the work, a referee point left for the authors) is a comment beside the text in the editor, never printed. The run also writes a sign-off sheet of what only the authors can decide (declarations, claims the system added, claims without a verified source, the comments left for them, decisions a third family made, skipped steps), the claim ledger in the evidence package, an evidence package of claims, evidence and sources in the Resolvent format, and the production journal itself.',
  'A person can be in the loop at any point without being required: the paper is written into the editor from its first step and kept in step while it runs; edits made there become the person\'s revision once they pause typing, and a section they write before the author reaches it is theirs; a comment, or a reply in any thread, becomes work that the agents take over by default, the person keeps (@humans) or both share (@both, as proposed changes they accept or decline); with citation choices on, each claim waits for the person to pick among its candidate sources (a, b, c), let the system pick, or state it without a source; the dial makes load-bearing citations and critical answers, or every answer, wait for the person.',
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

/** The software that produced a manuscript, as its production statement names it: "galley 0.1.0 (MIT license, https://…)". */
export function software(): string {
  const pkg = packageInfo()
  const repo = repositoryUrl(pkg)
  const details = [pkg.license ? `${pkg.license} license` : '', repo ?? ''].filter(Boolean).join(', ')
  return `galley${pkg.version ? ` ${pkg.version}` : ''}${details ? ` (${details})` : ''}`
}

/** Where galley's source is, for the availability statement of a paper about galley itself. */
export function sourceStatement(): string {
  const pkg = packageInfo()
  const repo = repositoryUrl(pkg)
  if (!repo) return ''
  return `galley's source code, including the behaviors that produced this manuscript, is available${pkg.license ? ` under the ${pkg.license} license` : ''} at ${repo}.`
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
    pkg.name ? `Package: ${pkg.name}${pkg.version ? ` ${pkg.version}` : ''}${pkg.license ? `, ${pkg.license} license` : ''}${repo ? `, source at ${repo}` : ''}.` : '',
    `Seats in this run: author ${who(c.seats.author)}; checker ${who(c.seats.checker)}; challenger ${who(c.seats.challenger)}; verifier ${who(c.seats.verifier)}; referees: ${c.referees.map((r) => r.seat).join(', ')} seats, drawn from the families other than the author's and rotated between rounds; adjudicator: the family that is neither the author's nor the referee's.`,
    `Settings in this run: dial ${dial}; citations ${c.citations}; ${c.rounds} referee round(s); up to ${c.fixAttempts} answers per finding before adjudication; up to ${c.candidatesPerClaim} candidate works per claim; about ${c.words} words; venue ${c.venue}.`,
    `The ladder (${ladder.length} behaviors, scanned in this order):`,
    ...ladder.map((b, i) => `${i + 1}. ${b.id} (${b.stage}, ${b.improver ? 'improver' : 'required'}): ${DOES[b.id] ?? b.title}`),
    'Rules the code enforces:',
    ...RULES.map((rule) => `- ${rule}`),
  ].filter(Boolean).join('\n')
}
