// Measure, then argue. When the authors bring a dataset, the argument is planned
// on what the data shows: the author names the analyses its claims need, galley
// computes them on this machine, and every number the paper states about the
// data is filled in from those results.
import { analyze, datasetRows, type AnalysisSpec, type Measurement } from '../materials.js'
import { HOUSE } from '../prompts.js'
import type { Behavior } from '../scheduler.js'
import { arr, enm, nobj, nstr, obj, str } from '../schema.js'
import { briefBlock, live, seatFamily } from './common.js'

const OPS = ['count', 'mean', 'median', 'sd', 'min', 'max', 'quantile', 'share', 'proportion', 'group_count', 'group_mean', 'correlation', 'mean_difference'] as const

export const analyzeData: Behavior = {
  id: 'analyze', stage: 'truth', improver: true, title: 'Measure the data',
  ready: (paper) => {
    const s = paper.state
    const datasets = (paper.config.materials ?? []).filter((m) => m.kind === 'dataset')
    if (!live(paper) || !s.brief?.hasSubject || !datasets.length || s.plan || s.measurements) return []
    // The analyses serve the chosen direction, so they wait for it.
    if (s.directions.length && !s.selectedDirection && !paper.config.off.includes('select-direction')) return []
    if (!paper.isSettled('review-idea:seed') && !paper.config.off.includes('review-idea')) return []
    return [{
      key: 'analyze:data', label: `analyses of ${datasets.map((d) => d.name).join(', ')}`,
      run: async () => {
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
        s.measurements = measurements
        paper.journal({ event: 'measured', behavior: 'analyze', count: Object.keys(measurements).length, failed: Object.values(measurements).filter((m) => m.error).map((m) => m.id) })
        paper.save()
      },
      // Without measurements the plan rests on the profiles alone.
      skip: () => { paper.state.measurements = {} },
    }]
  },
}
