# Papers

Galley turns a seed (a rant, notes, a transcribed talk) into a pre-publication manuscript: a typeset PDF with verified citations, LaTeX, Word, a sign-off sheet and an evidence package. The person gives the seed; atomic behaviors do the rest; nothing waits on the person unless they choose to be in the loop.

## Write a paper

```bash
npm install && npm run build
```

```bash
node dist/engine/cli.js write my-seed.md --author "Your Name"
```

That creates `papers/my-seed/`, runs it to the end and prints where the PDF is. A run is never silent: every step prints when it starts and settles, every model call or search still in flight is named once a minute with how long it has been going, and `galley status` shows what is running right now (also kept in `progress.json`). A run is resumable at any point: run it again and it continues from the last settled step, replaying every model answer it already has.

```bash
node dist/engine/cli.js run papers/my-seed
```

| Command | |
| --- | --- |
| `write <seed.md> [dir]` | start a paper and run it to the end |
| `new <dir> <seed.md>` | start a paper without running it |
| `run <dir> [--until behavior]` | run or resume; picks up what you changed in the editor first |
| `status <dir>` | where the paper stands, what is running right now, and what it cost |
| `papers [root]` | every paper under `papers/` (or `root`), one line each: outcome or what is running, and title |
| `typeset <dir>` | render the outputs again from the paper as it stands, with no model calls |
| `open <dir>` | how to open the manuscript and its notes in the editor |
| `choices <dir>` / `choose <dir> <claim> <a,b \| auto \| none>` | citation choices, when you asked for them |
| `ladder` | every behavior, in order |
| `doctor` | check that each model, tool and source answers |

`write` and `new` take `--author`, `--affiliation`, `--funding`, `--competing-interests`, `--acknowledgements` (declarations printed as written; left out, they stay out of the paper and the sign-off sheet asks for them), `--venue`, `--words`, `--rounds 1|2`, `--citations auto|choose|mixed`, `--dial autonomous|assisted|propose`, `--literature-review yes|load-bearing` (a systematic review of the literature, below), `--simulation yes|load-bearing` (a Monte Carlo simulation, below), `--web-sources no` (turns off primary sources from the web, below), `--dataset <dataset.json>` (a dataset as a unit, below), `--editor <dir>` (where the manuscript's editor document goes), and `--material <file or link>` and `--shared-material <dataset>` for your own materials (below), each as often as needed. Everything else is in the paper's `paper.json` (below).

## What comes out

In `papers/<slug>/out/`:

| File | |
| --- | --- |
| `paper.pdf` | the manuscript, typeset with Typst |
| `paper-review.pdf` | the same, line-numbered with wider spacing, as many journals ask for at submission |
| `paper.tex`, `paper.docx`, `paper.typ`, `manuscript.md`, `refs.bib`, `refs.json` | the same manuscript for other venues and tools |
| `signoff.md` | what only you can decide before submitting: declarations, claims the system added, claims stated as hypotheses, decisions a third model family made, steps that were skipped |
| `evidence/` | every claim, the evidence it rests on and the verbatim passage of each source, as Resolvent records (`claims/`, `evidence/`, `sources/`) |
| `production-journal.jsonl` | every step, model call, verdict and decision, with its time: the record that the paper was produced as described |
| `submission.zip` | all of the above |

The manuscript ends with its claim ledger as an appendix (every claim, its kind, its standing, whether the seed or the system made it, and the sources it rests on; `"ledgerAppendix": false` leaves it out), then a statement of how it was produced and its production record: model calls per family, tokens, claims added and narrowed, citations verified and rejected, referee findings and how they were resolved. Numbers about the run that the text itself states are written as placeholders and filled in from that record wherever the paper is shown.

Behind it, in the paper's folder: `seed.md`, `state.json` (everything decided so far), `journal.jsonl` (every step, call and outcome) and `calls/` (every prompt and answer). Every sentence traces back to the call that wrote it and the evidence it rests on.

## Who does what

Three model families take different seats, and no family reviews its own work.

| Seat | Family | Does |
| --- | --- | --- |
| Author | Claude Opus 5.5 | extracts the seed's claims, plans the argument, outlines, drafts, draws figures, frames, answers referees |
| Checker | GPT-6.2 Sol | writes literature searches, picks candidate passages, checks each section against its claims |
| Challenger | Gemini 4 Carbon | challenges the idea before drafting, reformulates it, reassesses a thesis that lost its evidence, profiles the finished paper |
| Verifier | Gemini 4 Carbon | verifies every citation against the passage it rests on |
| Referees | GPT-6.2 Sol and Gemini 4 Carbon | methods, field, citations and editor seats; families rotate between rounds and never include the author's |
| Adjudicator | the third family | settles a finding the author and referee could not agree on |

Every seat runs at full reasoning (Claude and GPT at xhigh, Gemini as Carbon at high), except the first answer to a referee finding and the referee's first judgment of it, which run on lighter settings: Claude and GPT at medium effort and Gemini as Hydrogen (`gemini-4-hydrogen-medium`). Once a referee rejects an answer, the author answers again at full effort; a judgment that cannot tell is asked again at full effort; adjudication always runs at full effort. The families and the rule that no family judges its own work stay the same; the AI statement names both settings.

No referee finding is dropped. Every finding, minor ones included, ends in one of these ways: fixed, rebutted or stated as a limitation with the agreement of the referee who raised it; decided by the third family, with the decision made in the text; set aside by the third family because the point does not hold, with the sentence of the text that answers it; or, when adjudication cannot settle it in the text, stated as a limitation of the work. Only a person can set a finding aside without the text answering it, by resolving its thread in the editor. A paper is ready only when every finding has ended one of these ways, and the AI statement and the sign-off sheet say how many ended each way.

The paper is also read as it is printed. Once the reviewed paper is typeset, a family other than the author's reads every page of the PDF: as images where it can see them (GPT, with `pdftoppm` installed) and as the pages' text in any case (`pdftotext`). Checks run alongside for what must never reach a page: placeholders, raw labels, unresolved references and blanks left for someone to fill. A defect in a section's words goes back to the author as exact edits, a defect in a figure has the figure drawn again with the defect named, and a claim-ledger entry the printed text does not bear out is restated as the text states it, or dropped. Then the paper is typeset and read again, up to three times. Whatever the agents cannot fix (layout, a reference entry) is listed in the sign-off sheet. A figure's numbers are written into it before it is drawn, display equations are numbered, and a declaration you have not made is left out of the paper rather than printed as a blank.

Each family runs through its own CLI with no tools and no delegation: Claude through `claude`, GPT through Codex (the CLI the ChatGPT app ships, which knows Sol 6.2), Gemini through `agy`. Literature search runs through Canary's search runtime over OpenAlex; bibliographic records come from the DOI registries.

When the seed is about galley itself (extract decides), every seat that writes or judges the manuscript also reads galley's description of itself: the ladder this run executes and what each behavior does (as `galley ladder` prints it), the seats and models, the run's settings and the rules the code enforces, generated from the code and the paper's configuration (`src/engine/self.ts`). A paper about galley therefore describes the system as it is, with nothing added to its seed. Every paper's production statement names the exact software that produced it.

## The ladder

Behaviors are atomic: each reads the paper's state, does one thing, and writes its result. The scheduler scans them in ladder order and runs whatever is ready; after anything settles it scans again from the top. No behavior knows what comes next. Long work outside the models (the systematic review) runs in the background, alongside the rest; the run waits for it only when nothing else is left to do.

| # | Behavior | Stage | Ready when | Does |
| --- | --- | --- | --- | --- |
| 1 | extract | skeleton | a seed exists | claims, concern, contribution, field |
| 2 | position | aim | the brief exists | searches prior art, the bottleneck and the consensus |
| 3 | review-idea | aim | positioned | scores the idea on the seven impact factors |
| 4 | reformulate | aim | the idea should be reframed | exactly three directions |
| 5 | select-direction | aim | directions exist | picks one (never the challenger's family) |
| 6 | literature-review | substance | asked for, the direction is chosen | the review question; Canary's systematic review in the background; its upheld findings join the ledger with verified passages |
| 7 | analyze | truth | a dataset was given, the direction is chosen | the analyses the claims need, computed on your machine |
| 8 | simulate | substance | asked for, the aim is settled (and the data measured) | the author's Monte Carlo spec with the basis of every input, run on your machine until it runs clean; the plan argues from its results |
| 9 | plan | skeleton | the aim is settled | thesis, the paper's noun, the full claim graph |
| 10 | outline | skeleton | planned | sections, figures, style, glossary |
| 11 | find-evidence | truth | external claims are open | searches, then verbatim passages from abstracts |
| 12 | verify | truth | citations are selected | supported, narrower (the claim is narrowed) or rejected |
| 13 | web-sources | truth | the scholarly index had no source for a claim | the primary document from its issuer, found on the web and kept; its passage goes to verification |
| 14 | reassess | truth | a load-bearing claim lost its evidence | the thesis stands, narrows, or fails |
| 15 | calibrate | truth | citations are verified | plants defects and measures what the verifier catches |
| 16 | draft | skeleton | a section's evidence is settled | the section, citing only verified keys |
| 17 | figure | substance | a figure is planned | Typst source, compiled |
| 18 | fidelity | truth | a section is drafted | fixes sentences that say more than their evidence |
| 19 | frame | manuscript | every section is checked, and again once the ledger is reconciled | title, abstract, keywords; rewritten from the reviewed text |
| 20 | referee | referees | framed, nothing open | four seats review the whole manuscript |
| 21 | close-round | referees | every seat reported | ends the round |
| 22 | respond | referees | a finding is open | fixed, rebutted, or stated as a limitation; after a rejected answer, at full effort |
| 23 | verify-disposition | referees | an answer is unverified | the referee who raised it judges the answer; a verdict that cannot tell is asked again |
| 24 | adjudicate | referees | a finding is still disputed at the cap | the third family decides, and the decision lands in the text |
| 25 | handle-finding | referees | adjudication could not settle a finding | the paper states it as a limitation of the work |
| 26 | reconcile | close | the review is done | a family other than the author's reads the final text against every claim: confirmed, narrowed to the text's wording, or dropped as no longer stated |
| 27 | reprofile | close | the review is done | the finished paper against the seven factors |
| 28 | typeset | skeleton | the text changed | PDF, LaTeX, Word, editor document, evidence package, sign-off |
| 29 | proof | close | the reviewed paper is typeset | a family other than the author's reads every printed page; defects go back to the author, the figure or the ledger, and the paper is typeset and read again |
| 30 | ready | close | every gate holds on one revision, the typeset reading included | ready for submission |

The skeleton (extract, plan, outline, draft, frame, typeset, ready) is what makes a paper exist. Everything else is an improver: it can make the paper better but can never stop it. An improver that fails twice is settled as skipped, its effect is written down (a claim without evidence is hedged; a figure is left out), and the paper moves on. A model provider at a usage limit is waited out for up to about six hours (a subscription's window), never counted as a failure; when the provider says when its quota resets, the call is tried again just after that; only a longer limit pauses the run, and running it again resumes it. A search index that is unavailable (OpenAlex pauses keyless search under heavy load) is waited out for up to three hours, retrying less often as the wait grows; after that the search is given up and the claims it was for are hedged.

Three things end a paper without a manuscript, each with a report: the seed has no subject; neither the idea nor any of its three reformulations has a contribution; the thesis fails once its evidence is in.

## Start a paper from the editor

Run the editor (`npm run dev`), write or paste your rant as a document, and press the play button (▷), **Write a paper from this document**. A four-step dialog opens; nothing starts until its last step:

1. **Seed.** Your words, as they are; nothing is added to them.
2. **Materials.** Drop datasets (CSV, TSV, JSON) and documents (Markdown, text, Word, PDF), or add links. Each dataset is private unless you switch it to shared.
3. **Settings.** Author and affiliation (set in the byline, never sent to a model), venue, length, one or two referee rounds, your part (autonomous, assisted, propose), how citations are chosen, whether to include a systematic literature review and a Monte Carlo simulation (each in support, or as the paper's main contribution), the seats and models, and whether literature search has an OpenAlex key.
4. **Start.** Every step the paper will go through, who does it and about how long it takes, and exactly what leaves your machine.

One document is one project. When the paper starts, your seed moves into the project's settings, where it stays for reference (folded away in the dialog and in the project's settings), and the document itself becomes the paper: the seed's text gives way to the working title, then the outline's sections, each section once it is drafted, and every revision after that. Press ▷ on the document any time for its stage, settings and seed. The run log is `papers/<your-document>/run.log`. Projects started before this keep their `<your-document>-paper` document and folder.

## Your own materials and private data

A paper can rest on your own material besides the literature. Datasets, documents and links are copied into the paper's `materials/` folder when it starts; links are read once then, so every step reads the same page.

- **A private dataset never leaves your machine.** The models see a profile of it (rows, columns, each column's type, missing values, summary statistics, and the values of repeating categories, never a value that occurs once) and the results galley computes.
- **Measure, then argue.** Before the argument is planned, the author names the analyses the claims need (counts, means, medians, proportions, group means, correlations, mean differences with Welch's t), and galley computes them on your machine. Every number the paper states about your data is a placeholder (`{{data.A1}}`) filled in from those results, never a figure a model wrote. The results, with the exact analysis behind each, go into the evidence package (`measurements.json`) and onto the sign-off sheet for you to check.
- **A shared dataset** shows the models its first 15 rows as well.
- **Documents and links** are read by the models that write and review the paper.
- **A dataset is a unit, of one file or many.** Data files added together in the start dialog, or a folder, become one dataset, with any README among them as its documentation; more files can be added to it. Each dataset says where it comes from: who produced it (you or your group, or others), where it is published (a DOI or a link), its version, the publication that first reported it, and its licence. That provenance decides how the paper describes the data. Data you produced for this paper is your own work. Data others produced, or data published before, is described as such and cited where the paper describes it: the dataset itself and the publication that first reported it are both in the references, and the data availability statement says where it is. From the command line, `--dataset <dataset.json>` takes a manifest: `{"name", "files": [paths relative to the manifest], "producedBy": "authors" | "others", "doi", "version", "describedIn", "licence", "private"}`.

## Primary sources from the web

Many claims rest on documents no scholarly index holds: a grid operator's product rules, a standard, a regulation, a datasheet, official statistics, a government report. When the scholarly search finds no source for a claim, GPT, with live web search, looks for the primary document from whoever issues it, preferring the issuer's own site and the current version and never news, blogs, encyclopedias or forums. galley fetches each document itself and keeps a copy with its fingerprint in the paper's `sources/` folder. The checker copies the exact passage that states the claim from that copy, and the passage goes to verification by another family like any other citation; the reference carries the publisher, the address and the date galley retrieved it. No passage, no citation: a document that cannot be read (paywalled, behind a login) is named in the sign-off sheet for you to supply. It is on by default; untick **Web sources** in the start dialog, or pass `--web-sources no`, to keep to the scholarly index. The searches send only the claims' own terms, never your private data.

## What the paper rests on

The systematic review and the simulation can each be added in one of two parts, chosen in the start dialog (Supporting or Main contribution) or with the flag's value:

| Part | Systematic review | Simulation |
| --- | --- | --- |
| Supporting (`yes`) | A review section after the introduction; the paper's own contribution stands beside it. The review runs alongside the rest. | Its results support the argument where they help. |
| Main contribution (`load-bearing`) | The paper is the systematic review: the plan waits for the review, the thesis states what it establishes, its findings are the contribution claims, and the outline takes a review's structure (introduction, methods, results by theme, discussion, limitations, conclusion). | The thesis rests on what the simulation shows: the contribution claims are claims about its results, load-bearing and written with placeholders; the outline specifies the model, reports the results, says how they depend on the assumptions, and charts them. |

Both can be added, and both can be load-bearing.

## Systematic literature review

Tick **Systematic literature review** in the start dialog (or pass `--literature-review yes`) and the paper gets a review section that reports a systematic review actually carried out for it, by Canary:

1. Once the paper's direction is chosen, the author writes the review question: what is already known about the subject, in the field's own words.
2. Canary does the review: its research model (GPT-6.1 Sol) writes a search plan of concepts and eligibility criteria, searches OpenAlex (titles, abstracts and indexed full text), screens the candidates by title and abstract, retrieves the open-access full texts, reads at least 50 publications and quotes the passages behind each finding; an independent model (GPT-6 Astra) then audits every finding against those passages. A run takes about 40 minutes and goes on in the background while the rest of the paper is written.
3. Each finding the audit upholds joins the claim ledger as a background claim, with its uncertainty, and each of its sources becomes a verified citation carrying Canary's passage. A finding the audit does not uphold stays out.
4. The review section is reserved after the introduction from the start (the outline then has no separate related-work section). It is drafted once the findings are in: how the review was done (how records were chosen for screening, why the search stopped, and its limits), with every count a placeholder filled from Canary's record ({{lit.reviewed}} and the rest), what the studies establish by theme, where they disagree and what they leave open, and where this paper stands. The fidelity check, the referees and the ledger reconciliation treat it like every other section.
5. An appendix reports the review so it can be checked and repeated: the question, source, eligibility, how the models screened, read and audited, why the search stopped, and what the review cannot claim (one database, open-access full texts only, model screening, a coverage stopping rule rather than exhaustion). It adds a flow figure drawn from Canary's counts, from records found to records included, with the exclusions at each step; every query; and a table of every included publication with its role (core or supporting) and why it was included. Each included publication is in the references, cited or not.

Canary's full research bundle is kept in the paper folder (`canary/review-bundle.json`); the evidence package adds `literature-review.json` (question, protocol, counts, models), and the sign-off sheet names the run so you can open it in Canary. The production record table and the AI statement say which citations Canary's audit checked rather than galley's verifier. If a review ends without an answer twice, the paper goes on without the section and the sign-off sheet says so.

## Monte Carlo simulation

Tick **Monte Carlo simulation** in the start dialog (or pass `--simulation yes`) and the argument rests on a simulation galley runs for the paper:

1. Once the aim is settled (and your data measured, when you brought a dataset), the author designs the simulation the argument needs, choosing plain Monte Carlo for independent uncertain inputs, correlated Monte Carlo when inputs move together, or sequential Monte Carlo when the system evolves over time. It gives the basis of every input's distribution: the seed, your materials, published ranges, or its own judgment, said as such.
2. Galley runs the specification on your machine with its simulation engine ([Simulations](SIMULATION.md)): deterministic for a seed, with the Monte Carlo error of every number and checks on precision. When the engine cannot run a specification, its problems go back to the author until it can.
3. The plan is made from the results. A claim about a simulation names it, says only what the results show under its assumptions, and writes every number as a placeholder such as `{{sim.S1.profit.p95}}`, filled in at typesetting to the precision its Monte Carlo error supports; a model never types a simulated figure. Figures may chart a run's distributions or a sequential run's bands from the run itself.

The sign-off sheet lists each simulation's inputs with their bases for you to check, the AI statement says how each ran, and the evidence package holds every specification with its results (`simulations/S1.json`), so anyone can rerun it and get the same numbers.

## The paper in the editor

Every paper is written into the editor's own document list (`.galley-data/`, or `GALLEY_DIR` when set) from its first step, and kept in step while it runs: galley writes what the paper now says after every step, and every few seconds while a model is working. `--editor <dir>` puts a paper's document somewhere else.

```bash
npm run dev
```

Open the paper's document and the team works in it with you:

- **Who is working on it.** A strip under the toolbar shows every seat (Author, Checker, Challenger, Verifier, the referees, the Adjudicator) with the model behind it, and what each is doing right now; a mark in the margin sits beside the passage each one is working on. Where the paper stands (writing, its stage, a usage limit being waited out, ready) is at the strip's end.
- **Working notes.** Above the text: what galley read in your seed, where the idea sits among prior work, its score, the direction chosen, the evidence, the claim ledger, the sections written and the review, each as it settles.
- **History.** The History button opens a pane beside the editor: what is happening now, and everything that has happened, by stage, with what is new since you last looked. An entry about a finding opens its thread.
- **Threads.** Every material referee finding is a thread under its passage: the referee's question opens it, and the Author's answers, the referee's verdict on each and a third family's decision follow as replies. A settled thread is resolved and drawn quietly.

You can work in it at any time, while the paper is being written:

- **Edit anything.** What you change becomes your revision of the paper as soon as you pause typing. A section you write before the Author reaches it is yours: the Author drafts only sections no one has written.
- **Comment anywhere, and reply in any thread.** A note or a reply becomes work for the agents within seconds of you pausing. By default the agents take it over; write `@humans` (or `@me`) to keep it yours, or `@both` to have the agents propose a change that you accept. The agents' answers arrive as replies in the same thread. Resolving a referee's thread settles it: the agents stop working on it.
- **Your edits are never written over.** Galley reads and writes the document only while you are not typing in it; if you and an agent change the same lines at once, your version stands, and the agent's is kept in the paper's revisions.
- **Proposed changes.** The check-mark button in the toolbar lists the changes waiting for you, each with its reason, its before and after, and the passage lit when you hover. Accept applies it as one saved, undoable edit; Decline closes it. Set `"dial": "propose"` to have every answer to a referee wait for you this way.
- **Choose citations.** With `"citations": "choose"` (every claim) or `"mixed"` (load-bearing and contested claims), each claim waits for you with its options a, b, c and the passage each would rest on. In the editor, the **Citation choices** button on the seed document lists them; pick one, or Let galley pick, or No source (the claim is then stated as a hypothesis). Once every choice is answered the paper carries on by itself. From the command line: `galley choices <dir>`, then `galley choose <dir> C12 a,c` (or `auto`, or `none`).

## paper.json

| Key | Default | |
| --- | --- | --- |
| `authors` | none | `[{ "name", "affiliation", "email" }]`, used at typesetting only and never sent to a model |
| `title` | the system's | overrides the title |
| `venue` | `preprint (arXiv)` | shapes the outline and the referees |
| `words` | 7000 | |
| `dial` | `autonomous` | `assisted`: citations for load-bearing claims and answers to critical findings wait for you; `propose`: every answer to a referee waits for your Accept |
| `citations` | `auto` | `choose` or `mixed` |
| `rounds` | 2 | referee rounds |
| `fixAttempts` | 3 | answers per finding before adjudication |
| `seats` | as above | e.g. `{ "author": "claude" }` |
| `models` | as above | e.g. `{ "gpt": { "model": "gpt-6.2-sol", "effort": "xhigh" } }` |
| `lightModels` | medium effort; Gemini 4 Hydrogen | the settings that answer, judge and settle single referee findings, e.g. `{ "gemini": { "model": "gemini-4-hydrogen-high", "effort": "high" } }` |
| `off` | none | behaviors to switch off, by id |
| `declarations` | none | `availability`, `competing_interests`, `funding` |

## Requirements

`claude` signed in (`claude auth login`), the ChatGPT app or `GALLEY_CODEX_BIN` pointing at a Codex CLI that serves `gpt-6.2-sol`, `agy` signed in, Canary installed as a uv tool, `pandoc` and `typst`. `galley doctor` checks all of them with one tiny call each.

OpenAlex budgets its API in credits per day. Without a key it allows 1,000 credits, and a search costs 10 credits whatever its page size. With a key, a paper runs 7 positioning searches and two per claim that needs evidence (about 30); without one, one deeper search per claim (about 20), so four to five papers a day get their evidence. A free key (openalex.org) gives ten times the budget: put `OPENALEX_API_KEY=…` (either case) in `~/.env` or in `~/.local/share/canary/.env`. Galley reads only that line and hands the key to Canary. `galley doctor` and the start of every run say how much of today's budget is left; a search that finds the budget spent is skipped at once, and its claims are stated as hypotheses.

## Tests

`tests/unit/engine.test.ts` holds the rules that need no model: exact edits, verbatim passages, citation keys, placeholders, and a scheduler that skips a failing improver and pauses on a failing skeleton step. The whole unit suite runs in about a second. A behavior is proven by running it on a real seed; its recorded calls in `calls/cache/` replay it without a model.
