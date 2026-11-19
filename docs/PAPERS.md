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

`write` and `new` take `--author`, `--affiliation`, `--venue`, `--words`, `--citations auto|choose|mixed`, `--dial autonomous|assisted|propose` and `--editor <dir>` (where the manuscript's editor document goes). Everything else is in the paper's `paper.json` (below).

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

Each family runs through its own CLI with no tools and no delegation: Claude through `claude`, GPT through Codex (the CLI the ChatGPT app ships, which knows Sol 6.2), Gemini through `agy`. Literature search runs through Canary's search runtime over OpenAlex; bibliographic records come from the DOI registries.

When the seed is about galley itself (extract decides), every seat that writes or judges the manuscript also reads galley's description of itself: the ladder this run executes and what each behavior does (as `galley ladder` prints it), the seats and models, the run's settings and the rules the code enforces, generated from the code and the paper's configuration (`src/engine/self.ts`). A paper about galley therefore describes the system as it is, with nothing added to its seed. Every paper's production statement names the exact software that produced it.

## The ladder

Behaviors are atomic: each reads the paper's state, does one thing, and writes its result. The scheduler scans them in ladder order and runs whatever is ready; after anything settles it scans again from the top. No behavior knows what comes next.

| # | Behavior | Stage | Ready when | Does |
| --- | --- | --- | --- | --- |
| 1 | extract | skeleton | a seed exists | claims, concern, contribution, field |
| 2 | position | aim | the brief exists | searches prior art, the bottleneck and the consensus |
| 3 | review-idea | aim | positioned | scores the idea on the seven impact factors |
| 4 | reformulate | aim | the idea should be reframed | exactly three directions |
| 5 | select-direction | aim | directions exist | picks one (never the challenger's family) |
| 6 | plan | skeleton | the aim is settled | thesis, the paper's noun, the full claim graph |
| 7 | outline | skeleton | planned | sections, figures, style, glossary |
| 8 | find-evidence | truth | external claims are open | searches, then verbatim passages from abstracts |
| 9 | verify | truth | citations are selected | supported, narrower (the claim is narrowed) or rejected |
| 10 | reassess | truth | a load-bearing claim lost its evidence | the thesis stands, narrows, or fails |
| 11 | calibrate | truth | citations are verified | plants defects and measures what the verifier catches |
| 12 | draft | skeleton | a section's evidence is settled | the section, citing only verified keys |
| 13 | figure | substance | a figure is planned | Typst source, compiled |
| 14 | fidelity | truth | a section is drafted | fixes sentences that say more than their evidence |
| 15 | frame | manuscript | every section is checked, and again once the ledger is reconciled | title, abstract, keywords; rewritten from the reviewed text |
| 16 | referee | referees | framed, nothing open | four seats review the whole manuscript |
| 17 | close-round | referees | every seat reported | ends the round |
| 18 | respond | referees | a material finding is open | fixed, rebutted, or stated as a limitation |
| 19 | verify-disposition | referees | an answer is unverified | the referee who raised it judges the answer |
| 20 | adjudicate | referees | a finding is still disputed at the cap | the third family decides |
| 21 | reconcile | close | the review is done | a family other than the author's reads the final text against every claim: confirmed, narrowed to the text's wording, or dropped as no longer stated |
| 22 | reprofile | close | the review is done | the finished paper against the seven factors |
| 23 | typeset | skeleton | the text changed | PDF, LaTeX, Word, editor document, evidence package, sign-off |
| 24 | ready | close | every gate holds on one revision | ready for submission |

The skeleton (extract, plan, outline, draft, frame, typeset, ready) is what makes a paper exist. Everything else is an improver: it can make the paper better but can never stop it. An improver that fails twice is settled as skipped, its effect is written down (a claim without evidence is hedged; a figure is left out), and the paper moves on. A model provider at a usage limit is waited out for up to about six hours (a subscription's window), never counted as a failure; only a longer limit pauses the run, and running it again resumes it. A search index that is unavailable (OpenAlex pauses keyless search under heavy load) is waited out for up to three hours, retrying less often as the wait grows; after that the search is given up and the claims it was for are hedged.

Three things end a paper without a manuscript, each with a report: the seed has no subject; neither the idea nor any of its three reformulations has a contribution; the thesis fails once its evidence is in.

## Start a paper from the editor

Run the editor (`npm run dev`), write or paste your rant as a document, and press the speech-bubble button, **Write a paper from this document**. Galley asks whether you want to pick the sources for the load-bearing claims yourself, then runs in the background. The manuscript arrives in the same document list as `<your-document>-paper` once it is typeset. Press the button again on the seed to see where the paper stands; its run log is `papers/<your-document>-paper/run.log`.

## When you want to be in it

The editor shows the manuscript's source, with a note on every material referee finding and how it was resolved:

```bash
GALLEY_DIR=papers/<slug>/editor npm run dev
```

- **Edit anything.** What you change becomes your revision of the paper on the next run.
- **Comment anywhere.** A note becomes a thread on the next run. By default the agents take it over; write `@humans` (or `@me`) to keep it yours, or `@both` to have the agents propose a change that you accept.
- **Proposed changes.** The check-mark button in the toolbar lists the changes waiting for you, each with its reason, its before and after, and the passage lit when you hover. Accept applies it as one saved, undoable edit; Decline closes it. Set `"dial": "propose"` to have every answer to a referee wait for you this way.
- **Choose citations.** With `"citations": "choose"` (every claim) or `"mixed"` (load-bearing and contested claims), each claim waits for you with its options a, b, c and the passage each would rest on. In the editor, the **Citation choices** button on the seed document lists them; pick one, or Let galley pick, or No source (the claim is then stated as a hypothesis). Once every choice is answered the paper carries on by itself. From the command line: `galley choices <dir>`, then `galley choose <dir> C12 a,c` (or `auto`, or `none`).

Comment and edit between runs, not while one is running.

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
| `off` | none | behaviors to switch off, by id |
| `declarations` | none | `availability`, `competing_interests`, `funding` |

## Requirements

`claude` signed in (`claude auth login`), the ChatGPT app or `GALLEY_CODEX_BIN` pointing at a Codex CLI that serves `gpt-6.2-sol`, `agy` signed in, Canary installed as a uv tool, `pandoc` and `typst`. `galley doctor` checks all of them with one tiny call each.

OpenAlex budgets its API in credits per day. Without a key it allows 1,000 credits, and a search costs 10 credits whatever its page size. With a key, a paper runs 7 positioning searches and two per claim that needs evidence (about 30); without one, one deeper search per claim (about 20), so four to five papers a day get their evidence. A free key (openalex.org) gives ten times the budget: put `OPENALEX_API_KEY=…` in `~/.local/share/canary/.env`. `galley doctor` and the start of every run say how much of today's budget is left; a search that finds the budget spent is skipped at once, and its claims are stated as hypotheses.

## Tests

`tests/unit/engine.test.ts` holds the rules that need no model: exact edits, verbatim passages, citation keys, placeholders, and a scheduler that skips a failing improver and pauses on a failing skeleton step. The whole unit suite runs in about a second. A behavior is proven by running it on a real seed; its recorded calls in `calls/cache/` replay it without a model.
