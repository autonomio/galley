// Measure, then argue, to the standard of the field. When the authors bring a
// dataset, the author plans its analysis (the field's conventions, the data
// preparation, and each analysis with its method, its uncertainty and the checks
// of its assumptions); a statistician from another family reviews the plan; and
// the analyses run as real code on this machine, sealed off from the network.
// Every number the paper states about the data is filled in from what that code
// printed, with its interval and its n; an analysis that did not run is never
// described. Without a Python and a sandbox, galley's built-in operations measure
// instead.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectionsPath, query, readConnections } from '../databases.js'
import { canSandbox, dependencyBatches, ensureAnalysisEnv, formatResult, runAnalysis, runPreparation, versions, type AnalysisRun } from '../analysis.js'
import { analyze, datasetRows, saveMaterials, type AnalysisSpec, type Material, type Measurement } from '../materials.js'
import { RateLimited } from '../models.js'
import { HOUSE } from '../prompts.js'
import type { Behavior } from '../scheduler.js'
import { arr, enm, nobj, nstr, obj, str } from '../schema.js'
import type { PlannedAnalysis } from '../types.js'
import { briefBlock, live, seatFamily } from './common.js'

const OPS = ['count', 'mean', 'median', 'sd', 'min', 'max', 'quantile', 'share', 'proportion', 'group_count', 'group_mean', 'correlation', 'mean_difference'] as const
/** Analyses whose code one call writes: at full effort an elaborate analysis takes several minutes to write. */
const CODE_BATCH = 2

const datasetsOf = (paper: Parameters<Behavior['ready']>[0]) => (paper.config.materials ?? []).filter((m) => m.kind === 'dataset')
/** The databases a paper draws on: their extracts become its datasets. */
const databasesOf = (paper: Parameters<Behavior['ready']>[0]) => (paper.config.datasets ?? []).filter((u) => u.connection)
/** What a planned analysis may name as its data: a dataset, or a database it takes extracts from. */
const sourceIds = (paper: Parameters<Behavior['ready']>[0]) => [...datasetsOf(paper).map((d) => d.id), ...databasesOf(paper).map((u) => u.id)]

const PLAN_FIELDS = {
  field: str(), conventions: arr(str()), preparation: arr(str()),
  analyses: arr(obj({ id: str(), claims: arr(str()), question: str(), method: str(), uncertainty: str(), assumptions: arr(str()), checks: arr(str()), datasets: arr(str()) })),
}
const PLAN_SCHEMA = obj(PLAN_FIELDS)

const planText = (plan: PlannedAnalysis[]) => plan.map((a) => `${a.id} (for ${a.claims.join(', ') || 'the paper'}, on ${a.datasets.join(', ')}): ${a.question}\n  method: ${a.method}\n  uncertainty: ${a.uncertainty}\n  assumptions: ${a.assumptions.join('; ') || 'none named'}\n  checks: ${a.checks.join('; ') || 'none named'}`).join('\n')

function toPlan(reply: any, datasetIds: string[]): PlannedAnalysis[] {
  return (reply.analyses ?? []).slice(0, 12).map((a: any, i: number) => ({
    id: /^P\d+$/.test(a.id) ? a.id : `P${i + 1}`, claims: (a.claims ?? []).map(String), question: String(a.question ?? ''), method: String(a.method ?? ''),
    uncertainty: String(a.uncertainty ?? ''), assumptions: (a.assumptions ?? []).map(String), checks: (a.checks ?? []).map(String),
    datasets: (a.datasets ?? []).map(String).filter((d: string) => datasetIds.includes(d)),
  })).filter((a: PlannedAnalysis, i: number, all: PlannedAnalysis[]) => a.question && all.findIndex((b) => b.id === a.id) === i)
}

/** The analyses the claims need, planned by the author to the standard of the data's field. */
export const planAnalysis: Behavior = {
  id: 'analysis-plan', stage: 'truth', improver: true, title: 'Plan the analysis',
  ready: (paper) => {
    const s = paper.state
    const datasets = datasetsOf(paper)
    if (!live(paper) || !s.brief?.hasSubject || (!datasets.length && !databasesOf(paper).length) || s.plan || s.measurements || s.analysis) return []
    // The analyses serve the chosen direction, so they wait for it.
    if (s.directions.length && !s.selectedDirection && !paper.config.off.includes('select-direction')) return []
    if (!paper.isSettled('review-idea:seed') && !paper.config.off.includes('review-idea')) return []
    return [{
      key: 'analysis-plan:data', label: `the analysis of ${datasets.map((d) => d.name).join(', ')}`,
      run: async () => {
        const reply = await paper.ask<any>({
          behavior: 'analysis-plan', target: 'data', seat: 'author', family: seatFamily(paper, 'author'),
          prompt: `${HOUSE}

You are the author. Before the argument is planned, plan the analysis of the authors' data to the standard of its field. Nothing has been computed yet; plan, do not report.
- field: the research field the analysis belongs to; conventions: that field's own requirements for preparing, analysing and reporting data like this (the standards, guidelines or established practices it follows), each as one sentence.
- preparation: the steps that make the data analysable as the field requires (units, which observations are valid, how groups are formed), each with its reason.
- analyses, at most 12, with ids P1, P2 …: what the claims need, including what could contradict them. Start with the descriptive statistics of each dataset and each group the claims compare: n, missing values, centre, spread and the quantiles the claims use. For each analysis give claims (the ids of the seed claims it serves), question, method (the estimator or test), uncertainty (how its confidence interval or test is computed, by a method valid for this data: for example a distribution-free interval for a quantile, or a block bootstrap when successive observations may be dependent), assumptions (what the method assumes), checks (how each assumption is checked on this data) and datasets (their ids).
Plan only what the datasets can answer.${databasesOf(paper).length ? ` A DATABASE among the materials gives its data as extracts: name it (its id) among an analysis's datasets, and plan what can be computed from tables aggregated in the database (counts, sums, quantiles, bars by time), since its largest tables hold far more rows than an analysis can take in. The extracts are written next, from this plan.` : ''}

${briefBlock(paper, { fullSchema: true })}

Claims in the seed:
${s.claims.map((c) => `- ${c.id} [${c.kind}] ${c.text}`).join('\n')}`,
          schema: PLAN_SCHEMA,
        })
        s.analysis = { field: String(reply.field ?? ''), conventions: (reply.conventions ?? []).map(String), preparation: (reply.preparation ?? []).map(String), plan: toPlan(reply, sourceIds(paper)), mode: 'code' }
        paper.save()
      },
      skip: () => { paper.state.analysis = { field: '', conventions: [], preparation: [], plan: [], mode: 'operations' } },
    }]
  },
}

/** A statistician from another family holds the plan to the field's standard before anything runs. */
export const reviewAnalysisPlan: Behavior = {
  id: 'analysis-review', stage: 'truth', improver: true, title: 'Review the analysis plan',
  ready: (paper) => {
    const a = paper.state.analysis
    if (!live(paper) || !a || a.reviewed || paper.state.measurements || !a.plan.length) return []
    return [{
      key: 'analysis-review:data', label: 'the analysis plan, by a statistician',
      run: async () => {
        const family = seatFamily(paper, 'checker')
        const reply = await paper.ask<any>({
          behavior: 'analysis-review', target: 'data', seat: 'checker', family,
          prompt: `${HOUSE}

You are a statistician reviewing the analysis plan below before any analysis runs, for a paper in ${a.field || 'its field'}. Hold it to the standard of that field and of sound statistical practice:
- add the field's own requirements for preparing, analysing and reporting such data that the plan misses;
- every estimate the paper will state needs its n and its uncertainty, computed by a method valid for this data (dependence between successive observations, small samples, heavy tails, several comparisons at once);
- every method's assumptions need a check on this data, and the plan must say what follows if a check fails;
- reshape or remove anything the datasets cannot answer, and anything that would let the paper claim more than the data supports.
Return the plan as it should run (every analysis, revised, with the same fields), the conventions and preparation as they should stand, and notes: what you changed and why, one sentence each.

The field's conventions, as the author named them:
${a.conventions.map((c) => `- ${c}`).join('\n') || '- none named'}
Preparation:
${a.preparation.map((p) => `- ${p}`).join('\n') || '- none named'}
The plan:
${planText(a.plan)}

${briefBlock(paper, { fullSchema: true })}`,
          schema: obj({ ...PLAN_FIELDS, notes: arr(str()) }),
        })
        const revised = toPlan(reply, sourceIds(paper))
        if (revised.length) a.plan = revised
        if (reply.conventions?.length) a.conventions = reply.conventions.map(String)
        if (reply.preparation?.length) a.preparation = reply.preparation.map(String)
        if (reply.field) a.field = String(reply.field)
        a.reviewed = { family, notes: (reply.notes ?? []).map(String) }
        paper.note('analysis-review', `The analysis plan was reviewed by a statistician (${family}): ${a.reviewed.notes.join(' ') || 'no changes'}`, true)
        paper.save()
      },
      // An unreviewed plan still runs; the sign-off sheet says it was not reviewed.
      skip: () => { if (paper.state.analysis) paper.state.analysis.reviewed = { family: seatFamily(paper, 'checker'), notes: ['the review could not run'] } },
    }]
  },
}

/** Extracts per call to the database's author, and how many may be taken. */
const MAX_EXTRACTS = 12

/** SQL an extract may run: one statement that reads; the limits it runs under are galley's, never the query's own. */
function extractProblem(sql: string): string | null {
  const text = sql.trim().replace(/;\s*$/, '')
  if (!/^(SELECT|WITH)\b/i.test(text)) return 'an extract is one SELECT (or WITH … SELECT) statement'
  if (/;/.test(text)) return 'an extract is one statement'
  if (/\bSETTINGS\b/i.test(text)) return 'an extract may not set its own settings; galley sets the limits'
  if (/\bFORMAT\b\s+\w+\s*$/i.test(text)) return 'an extract does not name a format; galley reads it as CSV'
  return null
}

/**
 * The extracts the reviewed plan needs from a database: the author writes each as a read-only ClickHouse query that
 * aggregates in the database, galley runs it under its limits, and each table it returns becomes a private dataset
 * the shared preparation and the analyses start from. The queries go into the evidence package, so anyone with access
 * to the database can extract them again.
 */
export const extractData: Behavior = {
  id: 'extract-data', stage: 'truth', improver: true, title: 'Extract from the database',
  ready: (paper) => {
    const s = paper.state
    const databases = databasesOf(paper)
    if (!live(paper) || !databases.length || s.plan || s.measurements) return []
    if (!s.analysis || (s.analysis.plan.length && !s.analysis.reviewed) || s.analysis.extracts) return []
    return [{
      key: 'extract-data:data', label: `extracts from ${databases.map((d) => d.name).join(', ')}`,
      run: async () => {
        const a = s.analysis!
        const write = async (errors: Record<string, string> = {}, done: string[] = []) => (await paper.ask<any>({
          behavior: 'extract-data', target: Object.keys(errors).join(',') || 'data', seat: 'author', family: seatFamily(paper, 'author'),
          prompt: `${HOUSE}

Write the extracts the planned analyses below need from the database, each as one read-only ClickHouse query: one SELECT (or WITH … SELECT) statement, no SETTINGS, no FORMAT. Aggregate in the database (counts, sums, quantiles, bars by time, samples drawn by a stated rule) and never pull the raw rows of a large table: an extract returns at most 1,000,000 rows and runs under a time limit. Give each an id (E1, E2 …), the database it reads (its id), purpose (what the analyses use it for, and which ones) and sql. Use only the tables and columns the schema gives. At most ${MAX_EXTRACTS}.
${Object.keys(errors).length ? `\nThese extracts failed; give each again, fixed, with the same id:\n${Object.entries(errors).map(([id, e]) => `${id}: ${e}`).join('\n')}\n${done.length ? `These already ran and stay as they are: ${done.join(', ')}.\n` : ''}` : ''}
The field and its conventions: ${a.field}. ${a.conventions.join(' ')}
The planned analyses:
${planText(a.plan)}

${briefBlock(paper, { fullSchema: true })}`,
          schema: obj({ extracts: arr(obj({ id: str(), database: str(), purpose: str(), sql: str() })) }),
        })).extracts ?? []
        const extracts: NonNullable<typeof a.extracts> = []
        const runOne = async (e: any) => {
          const unit = databasesOf(paper).find((u) => u.id === e.database) ?? databasesOf(paper)[0]
          const id = /^E\d+$/.test(e.id) ? e.id : `E${extracts.length + 1}`
          const record = { id, database: unit.id, purpose: String(e.purpose ?? ''), sql: String(e.sql ?? '').trim(), ok: false } as NonNullable<typeof a.extracts>[number]
          const problem = extractProblem(record.sql)
          if (problem) return { ...record, error: problem }
          const connection = readConnections().find((c) => c.name === unit.connection)
          if (!connection) return { ...record, error: `the connection "${unit.connection}" is not in ${connectionsPath()} on this machine` }
          const started = Date.now()
          try {
            const csv = await query(connection, unit.database!, record.sql)
            const rows = Math.max(0, csv.trim().split('\n').length - 1)
            if (!rows) return { ...record, error: 'it returned no rows', ms: Date.now() - started }
            const materialId = `M${(paper.config.materials ?? []).length + 1}`
            const file = join('materials', `${materialId}-${unit.id}-${id}.csv`)
            writeFileSync(paper.path(file), csv)
            const material: Material = { id: materialId, kind: 'dataset', name: `${unit.name} › ${id}: ${record.purpose.slice(0, 80)}`, file, private: unit.private, dataset: unit.id }
            paper.config.materials = [...(paper.config.materials ?? []), material]
            unit.materials.push(materialId)
            return { ...record, ok: true, rows, material: materialId, sha256: createHash('sha256').update(csv).digest('hex'), ms: Date.now() - started }
          } catch (error) {
            return { ...record, error: (error as Error).message.slice(0, 600), ms: Date.now() - started }
          }
        }
        for (const e of (await write()).slice(0, MAX_EXTRACTS)) extracts.push(await runOne(e))
        // What failed is written again once, with its error.
        const failed = extracts.filter((e) => !e.ok)
        if (failed.length) {
          const again = await write(Object.fromEntries(failed.map((e) => [e.id, e.error ?? 'it did not run'])), extracts.filter((e) => e.ok).map((e) => e.id))
          for (const e of again) {
            const at = extracts.findIndex((x) => x.id === e.id && !x.ok)
            if (at >= 0) extracts[at] = await runOne(e)
          }
        }
        a.extracts = extracts
        saveMaterials(paper)
        const missing = extracts.filter((e) => !e.ok)
        if (missing.length) paper.note('extract-data', `Extracts that could not be taken from the database, so no analysis rests on them: ${missing.map((e) => `${e.id} (${e.purpose}): ${e.error}`).join('; ')}`, true)
        paper.journal({ event: 'extracted', extracts: extracts.length, rows: extracts.reduce((n, e) => n + (e.rows ?? 0), 0), failed: missing.map((e) => e.id) })
        paper.save()
      },
      // Without extracts the analyses have nothing from the database; they run on the rest of the data, if any.
      skip: () => { if (paper.state.analysis) paper.state.analysis.extracts = [] },
    }]
  },
}

export const analyzeData: Behavior = {
  id: 'analyze', stage: 'truth', improver: true, title: 'Measure the data',
  ready: (paper) => {
    const s = paper.state
    const datasets = datasetsOf(paper)
    if (!live(paper) || (!datasets.length && !databasesOf(paper).length) || s.plan || s.measurements) return []
    if (!s.analysis || (s.analysis.plan.length && !s.analysis.reviewed)) return []
    // A database's extracts come first: they are the data the analyses run on.
    if (databasesOf(paper).length && !s.analysis.extracts) return []
    return [{
      key: 'analyze:data', label: `analyses of ${datasets.map((d) => d.name).join(', ')}`,
      run: async () => {
        const a = s.analysis!
        const python = a.plan.length && canSandbox() ? await ensureAnalysisEnv((line) => paper.say(`… analyze: ${line}`)) : null
        if (!python) {
          a.mode = 'operations'
          if (a.plan.length) paper.note('analyze', canSandbox() ? 'No Python with numpy, scipy, pandas and statsmodels could be had, so the data was measured with galley\'s built-in operations.' : 'This machine cannot run code sealed off from the network, so the data was measured with galley\'s built-in operations.', true)
          s.measurements = await measureWithOperations(paper)
          paper.save()
          return
        }
        a.mode = 'code'
        a.environment = await versions(python)
        const data = Object.fromEntries(datasets.map((d) => [d.id, paper.path(d.file!)]))
        const ids = datasets.map((d) => d.id).join(', ')
        const context = `The field and its conventions: ${a.field}. ${a.conventions.join(' ')}\nPreparation:\n${a.preparation.map((p) => `- ${p}`).join('\n') || '- none'}`

        // The shared preparation, written once and checked before any analysis builds on it: every analysis then starts
        // from the same prepared data and uses the same methods for what several of them share.
        const writePrep = async (error = '') => String((await paper.ask<any>({
          behavior: 'analyze', target: 'preparation', seat: 'author', family: seatFamily(paper, 'author'),
          prompt: `${HOUSE}

Write the shared preparation for the analyses of the authors' data, in Python: the code every planned analysis below will start from, so they all use the same data and the same methods.
- def prepare(data): data maps dataset ids (${ids}) to pandas DataFrames with the columns the profiles give. Apply the preparation steps as the plan states them, and return a dict: the prepared tables and series the analyses need, under clear names, and "report": {"steps": [{"step", "rows_before", "rows_after", "note"}], "definitions": [one sentence each: the definitions and choices every analysis shares, such as how a trial counts as on time, or how the error rate is split across a family of estimates]}. Report every exclusion with its count.
- Define, beside prepare, the methods several analyses share (for example an interval for a quantile, a block bootstrap, the error-rate split), so each analysis calls them instead of writing its own.
Import only numpy, scipy, pandas and statsmodels; read no files, use no network, draw nothing. Never write a number from the profiles into the code. Where the data cannot establish a preparation step (a column it lacks), skip that step and say so in its note.

${context}

The planned analyses it serves:
${planText(a.plan)}
${error ? `\nThe last version failed when it ran; fix it:\n${error}` : ''}

${briefBlock(paper)}`,
          schema: obj({ code: str() }),
        })).code ?? '')
        let prep = ''
        let prepared: Awaited<ReturnType<typeof runPreparation>> = { ok: false, error: 'not written' }
        for (let i = 0; i < 2 && !prepared.ok; i++) {
          try { prep = await writePrep(i ? prepared.error : '') } catch (error) { if (error instanceof RateLimited) throw error; prepared = { ok: false, error: (error as Error).message.slice(0, 300) }; continue }
          prepared = prep ? await runPreparation(python, paper.path('analysis', 'preparation'), prep, data) : { ok: false, error: 'no code was written' }
        }
        a.prepare = { ok: prepared.ok, code: prep, ...(prepared.report ? { report: prepared.report } : {}), ...(prepared.error ? { error: prepared.error } : {}) }
        if (!prepared.ok) { prep = ''; paper.note('analyze', `The shared preparation did not run (${(prepared.error ?? '').split('\n').at(-1)}), so each analysis prepares its own data.`, true) }

        const write = async (items: PlannedAnalysis[], errors: Record<string, string> = {}) => (await paper.ask<any>({
          behavior: 'analyze', target: items.map((i) => i.id).join(','), seat: 'author', family: seatFamily(paper, 'author'),
          prompt: `${HOUSE}

Write the Python for each planned analysis below, exactly as the plan says. ${prep ? `Each is a function def run(prepared, data): prepared is what the shared preparation below returned, and data maps dataset ids (${ids}) to the raw DataFrames. Start from prepared and call the shared methods; never redefine them, and never prepare the data again.` : `Each is a function def run(data): where data maps dataset ids (${ids}) to pandas DataFrames with the columns the profiles give. Apply the preparation steps first.`} Import only numpy, scipy, pandas and statsmodels; read no files, use no network, draw nothing. Return {"results": [...], "checks": [...]}:
- each result: name (short, unique within the analysis), value (a number computed from the data), unit ("share" for a proportion between 0 and 1, otherwise the unit), n (the observations behind it), count (for a share: how many met it), ci_low, ci_high, ci_level (the interval the plan asks for, computed by the method it names) and method (one plain sentence);
- each check: assumption, method, statistic, p, holds (true or false) and note (what follows for the analysis).
Never write a number from the profiles into the code, and never return a result the code did not compute from the data. Where the data cannot answer part of an analysis, return what it can answer and say why in a check.

${context}
${prep ? `\nTHE SHARED PREPARATION AND METHODS (already written, run before each analysis):\n\`\`\`python\n${prep}\n\`\`\`\nIts report: ${JSON.stringify(a.prepare?.report ?? {})}\n` : ''}
${planText(items)}
${Object.keys(errors).some((id) => errors[id]) ? `\nThese analyses failed when they ran; fix each:\n${Object.entries(errors).filter(([, e]) => e).map(([id, e]) => `${id}: ${e}`).join('\n')}` : ''}

${briefBlock(paper)}`,
          schema: obj({ analyses: arr(obj({ id: str(), code: str() })) }),
        })).analyses ?? []
        const runs: Record<string, AnalysisRun & { code: string; attempts: number }> = {}
        // Analyses that build on one another are written together; the rest a few to a call, side by side.
        const attempt = async (items: PlannedAnalysis[], errors?: Record<string, string>) => {
          await Promise.all(dependencyBatches(items, CODE_BATCH, CODE_BATCH + 1).map(async (group) => {
            let codes: any[] = []
            let why = 'no code was written for it'
            try { codes = await write(group, errors ? Object.fromEntries(group.map((g) => [g.id, errors[g.id] ?? ''])) : {}) } catch (error) {
              // A provider limit is waited out by the scheduler; any other failure of the call is this group's, and its analyses try again.
              if (error instanceof RateLimited) throw error
              why = `the code could not be written: ${(error as Error).message.slice(0, 300)}`
            }
            for (const item of group) {
              const code = String(codes.find((c: any) => c.id === item.id)?.code ?? '')
              const run = code ? await runAnalysis(python, paper.path('analysis', item.id), code, data, prep) : { ok: false, results: [], checks: [], error: why, ms: 0 }
              runs[item.id] = { ...run, code, attempts: (runs[item.id]?.attempts ?? 0) + 1 }
            }
          }))
        }
        await attempt(a.plan)
        // What failed is written again once, with its error.
        const failed = a.plan.filter((p) => !runs[p.id]?.ok)
        if (failed.length) await attempt(failed, Object.fromEntries(failed.map((p) => [p.id, runs[p.id]?.error ?? 'it did not run'])))
        a.runs = Object.fromEntries(Object.entries(runs).map(([id, r]) => [id, { ok: r.ok, code: r.code, results: r.results, checks: r.checks, error: r.error, attempts: r.attempts, ms: r.ms }]))
        a.notComputed = a.plan.filter((p) => !runs[p.id]?.ok).map((p) => ({ id: p.id, question: p.question, why: runs[p.id]?.error ?? 'it did not run' }))
        // Every number the code printed becomes a measurement the text can cite by its placeholder.
        const measurements: Record<string, Measurement> = {}
        let k = 0
        for (const p of a.plan) {
          for (const r of runs[p.id]?.ok ? runs[p.id].results : []) {
            const id = `A${++k}`
            const shown = formatResult(r)
            measurements[id] = { id, analysis: p.id, name: r.name, value: shown.value, ...(shown.ci ? { ci: shown.ci } : {}), summary: `${p.id} ${shown.summary}`, n: r.n ?? 0 }
          }
        }
        s.measurements = measurements
        if (a.notComputed.length) paper.note('analyze', `Planned but not computed, so never described in the paper: ${a.notComputed.map((n) => `${n.id} (${n.question}): ${n.why.split('\n').at(-1)}`).join('; ')}`, true)
        paper.journal({ event: 'measured', behavior: 'analyze', mode: 'code', analyses: a.plan.length, results: k, failed: a.notComputed.map((n) => n.id) })
        paper.save()
      },
      // Without measurements the plan rests on the profiles alone.
      skip: () => { paper.state.measurements = {} },
    }]
  },
}

/** galley's built-in operations, for a machine that cannot run analysis code sealed off. */
async function measureWithOperations(paper: Parameters<Behavior['ready']>[0]): Promise<Record<string, Measurement>> {
  const s = paper.state
  const datasets = datasetsOf(paper)
  const reply = await paper.ask<any>({
    behavior: 'analyze', target: 'data', seat: 'author', family: seatFamily(paper, 'author'),
    prompt: `${HOUSE}

You are the author. Before the argument is planned, name the analyses of the authors' datasets that the paper needs: the measurements its claims will rest on. Galley computes each one on the authors' machine, and the plan is made from the results. Ask for what tests the seed's claims in the chosen direction, including what could contradict them. Use only these operations:
- count: rows.
- mean, median, sd, min, max: of a numeric column.
- quantile: the value of a numeric column at a probability given in value (0.95 for the 95th percentile, 0.99, 0.999).
- share: the share of a numeric column's values that meet the threshold in value (<700, <=1300, >2000).
- proportion: share of rows where column equals value.
- group_count: rows per value of by.
- group_mean: mean of column per value of by.
- correlation: Pearson r between column and column2, with n and p.
- mean_difference: mean of column in group A minus group B, where by splits the rows and value is "A|B"; Welch's t, df and p.
where, when given, keeps only the rows where column compares to value (op eq, ne, gt, lt, or in with values joined by |). Use column names exactly as the profile gives them. At most 12 analyses, with ids A1, A2 …; say in why which claim each one serves.
${s.analysis?.plan.length ? `\nThe analysis plan, which these operations should follow as far as they can:\n${planText(s.analysis.plan)}\n` : ''}
${briefBlock(paper)}

Claims in the seed:
${s.claims.map((c) => `- ${c.id} [${c.kind}] ${c.text}`).join('\n')}`,
    schema: obj({ analyses: arr(obj({
      id: str(), dataset: str(), op: enm(OPS), column: nstr(), column2: nstr(), by: nstr(), value: nstr(),
      where: nobj({ column: str(), op: enm(['eq', 'ne', 'gt', 'lt', 'in']), value: str() }), why: str(),
    })) }),
  })
  const measurements: Record<string, Measurement> = {}
  for (const [i, a] of (reply.analyses ?? []).slice(0, 12).entries()) {
    const id = /^A\d+$/.test(a.id) && !measurements[a.id] ? a.id : `A${i + 1}`
    const dataset = datasets.find((d) => d.id === a.dataset || d.name === a.dataset) ?? datasets[0]
    const spec: AnalysisSpec = { id, dataset: dataset.id, op: a.op, column: a.column, column2: a.column2, by: a.by, value: a.value, where: a.where }
    measurements[id] = analyze(datasetRows(paper, dataset), spec)
  }
  paper.journal({ event: 'measured', behavior: 'analyze', mode: 'operations', count: Object.keys(measurements).length, failed: Object.values(measurements).filter((m) => m.error).map((m) => m.id) })
  return measurements
}
