// Simulate, then argue. When the authors ask for a simulation, the author
// designs the Monte Carlo model the argument needs, galley runs it on this
// machine, and the plan is made from the results; every simulated number the
// paper states is filled in from that run.
import { HOUSE } from '../prompts.js'
import type { Behavior } from '../scheduler.js'
import { arr, obj, str } from '../schema.js'
import { simulate, specGuide, specSchema } from '../simulation/index.js'
import type { SimulationRun } from '../simulations.js'
import { briefBlock, live, seatFamily } from './common.js'
import { aimSettled } from './front.js'

const MAX_RUNS = 4

export const simulateModel: Behavior = {
  id: 'simulate', stage: 'substance', improver: true, title: 'Simulate', attempts: 3,
  ready: (paper) => {
    const s = paper.state
    if (!paper.config.simulation || !live(paper) || !s.brief?.hasSubject || s.plan || s.simulations || !aimSettled(paper)) return []
    // With a dataset, the simulation can rest on what the data shows.
    if ((paper.config.materials ?? []).some((m) => m.kind === 'dataset') && !s.measurements && !paper.config.off.includes('analyze')) return []
    return [{
      key: 'simulate:paper', label: 'the Monte Carlo simulation',
      run: async () => {
        let problems: string[] = []
        let previous = ''
        let runs: Record<string, SimulationRun> = {}
        // The engine's problems go back to the author until every spec runs, at most twice.
        for (let round = 0; round < 3; round++) {
          const reply = await paper.ask<any>({
            behavior: 'simulate', target: round ? `repair-${round}` : 'design', seat: 'author', family: seatFamily(paper, 'author'),
            prompt: `${HOUSE}

You are the author. This paper includes a Monte Carlo simulation, run on the authors' machine before the argument is planned; the plan is then made from its results. Design the simulation the argument needs: one, or up to ${MAX_RUNS} when the argument compares separate models (a baseline and an alternative sharing a seed, say) or tests whether a conclusion survives a different setting of an input chosen by judgment.
- Choose the method that fits: monte_carlo for independent uncertain inputs, correlated when inputs move together, sequential when the system evolves over time, with or without observations.
- Every input's distribution rests on something stated: the seed, the authors' materials and measurements, or ranges published in the field. Give each input's basis in assumptions (name, basis); where the basis is the authors' judgment, say so. Do not claim precision the basis does not have.
- Where a conclusion could turn on an input set by judgment, add a run that sets that input otherwise within its plausible range (neutral, or at its other end), with the same seed, so the paper can say whether the conclusion holds across that range or only under the setting assumed.
- Outputs are the quantities the paper will argue from; events are the thresholds it cares about.
- Simulate only what the model cannot settle by algebra. Where an output or event follows from the model's own formulas for every setting of the inputs (a ratio that always exceeds one, an ordering that always holds), derive it and state it as derived; sampling it adds no evidence. Use the draws for what depends on how the uncertain inputs combine.
- Keep the model as small as the argument allows.
- purpose: what the simulation shows for the paper, in one or two sentences.
${paper.config.simulation === 'load-bearing' ? '- The paper\'s main contribution rests on this simulation: design it to answer the paper\'s question decisively, with the baseline and the comparisons the argument needs, and enough draws or particles that the numbers the thesis rests on pass their precision checks.\n' : ''}
${specGuide()}

${briefBlock(paper)}

Claims in the seed:
${s.claims.map((c) => `- ${c.id} [${c.kind}] ${c.text}`).join('\n')}
${problems.length ? `\nYour previous specs:\n${previous}\n\nThe engine could not run them:\n${problems.map((p) => `- ${p}`).join('\n')}\nReturn the complete set again with these fixed.` : ''}`,
            schema: obj({ simulations: arr(obj({ purpose: str(), assumptions: arr(obj({ name: str(), basis: str() })), spec: specSchema })) }),
          })
          problems = []
          runs = {}
          const sims = (reply.simulations ?? []).slice(0, MAX_RUNS)
          previous = JSON.stringify(sims.map((x: any) => x.spec), null, 1)
          for (const [i, sim] of sims.entries()) {
            const wanted = String(sim.spec?.id ?? '')
            const id = /^[A-Za-z][A-Za-z0-9_]*$/.test(wanted) && !runs[wanted] ? wanted : `S${i + 1}`
            const out = simulate({ ...sim.spec, id })
            if (!out.ok) { problems.push(...out.problems.map((p) => `${id} ${p.at}: ${p.message}`)); continue }
            runs[id] = { id, title: out.result.title, purpose: String(sim.purpose ?? ''), assumptions: sim.assumptions ?? [], result: out.result }
          }
          if (!problems.length && Object.keys(runs).length) break
        }
        if (!Object.keys(runs).length) throw new Error(`no simulation could run: ${problems.slice(0, 4).join('; ')}`)
        s.simulations = runs
        for (const run of Object.values(runs)) {
          const p = run.result.provenance
          paper.journal({ event: 'simulated', id: run.id, method: p.method, size: p.size, seed: p.seed, fingerprint: p.fingerprint, ms: Math.round(p.runtimeMs), checks_ok: p.ok })
        }
        if (problems.length) paper.note('simulate', `Simulations left out after repair: ${problems.slice(0, 4).join('; ')}`)
        paper.save()
      },
      // Without a simulation the paper is planned as if none had been asked for; the sign-off sheet says why.
      skip: () => {
        s.simulations = {}
        paper.note('simulate', 'The simulation could not be built, so the paper has none.', true)
      },
    }]
  },
}
