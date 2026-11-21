// The analysis of the authors' data: what the code prints is all the paper may
// state, each number with its n and interval, and the code runs sealed off.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canSandbox, dependencyBatches, formatResult, readRun, runAnalysis, runPreparation } from '../../src/engine/analysis.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('analysis results', () => {
  it('keeps only named, finite numbers and checks that say whether they hold', () => {
    const { results, checks } = readRun('{"results": [{"name": "p99", "value": 422.2, "unit": "ms", "n": 147, "ci_low": 400.1, "ci_high": 437, "method": "order statistic"}, {"name": "broken", "value": null}], "checks": [{"assumption": "independent trials", "method": "Ljung-Box, lag 10", "p": 0.001, "holds": false, "note": "intervals use a block bootstrap"}]}')
    expect(results).toEqual([{ name: 'p99', value: 422.2, unit: 'ms', n: 147, ci_low: 400.1, ci_high: 437, ci_level: 0.95, method: 'order statistic' }])
    expect(checks).toEqual([{ assumption: 'independent trials', method: 'Ljung-Box, lag 10', p: 0.001, holds: false, note: 'intervals use a block bootstrap' }])
  })

  it('states a share with its count and n, and a number with its unit and interval', () => {
    expect(formatResult({ name: 'on time', value: 75 / 121, unit: 'share', n: 121, count: 75, ci_low: 0.53, ci_high: 0.71, method: 'Wilson' }).value).toBe('61.98% (75 of 121)')
    expect(formatResult({ name: 'p99', value: 10634.4, unit: 'ms', n: 217, ci_low: 10102.5, ci_high: 10699, method: 'order statistic' })).toMatchObject({ value: '10,634.4 ms', ci: '95% CI 10,102.5 ms to 10,699 ms' })
  })
})

describe('writing the analyses', () => {
  it('keeps analyses that build on one another in one call, and packs the rest a few to a call', () => {
    const p = (id: string, uses = '') => ({ id, question: `question ${id}`, method: uses ? `as in ${uses}` : 'a method', uncertainty: '', checks: [] })
    const batches = dependencyBatches([p('P1'), p('P2'), p('P3', 'P1'), p('P4'), p('P5', 'P3'), p('P6'), p('P7')], 3)
    expect(batches.map((b) => b.map((x) => x.id))).toEqual([['P1', 'P3', 'P5'], ['P2', 'P4', 'P6'], ['P7']])
  })
})

// A Python with numpy and pandas, when this machine has one to test with.
const python = [process.env.GALLEY_ANALYSIS_PYTHON, join(homedir(), '.galley', 'analysis', '.venv', 'bin', 'python'), join(homedir(), '.local', 'share', 'uv', 'tools', 'canary', 'bin', 'python3')].find((p) => p && existsSync(p))

describe.skipIf(!python || !canSandbox())('the sandbox', () => {
  it('runs an analysis on the data it is given, with no network', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    writeFileSync(join(dir, 'm1.csv'), `delay\n${Array.from({ length: 200 }, (_, i) => 100 + (i % 50)).join('\n')}\n`)
    const code = `
import socket
def run(data):
    d = data["M1"]["delay"]
    try:
        socket.create_connection(("example.org", 80), timeout=3)
        network = True
    except Exception:
        network = False
    return {"results": [{"name": "median", "value": float(d.median()), "unit": "ms", "n": int(d.size), "method": "sample median"}],
            "checks": [{"assumption": "no network", "method": "a connection attempt", "holds": not network, "note": ""}]}`
    const run = await runAnalysis(python!, join(dir, 'A1'), code, { M1: join(dir, 'm1.csv') })
    expect(run.ok).toBe(true)
    expect(run.results).toEqual([{ name: 'median', value: 124.5, unit: 'ms', n: 200, method: 'sample median' }])
    expect(run.checks[0].holds).toBe(true)
  })

  it('checks the shared preparation once, and starts every analysis from what it prepared', async () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-test-'))
    writeFileSync(join(dir, 'm1.csv'), `delay\n${Array.from({ length: 200 }, (_, i) => 100 + (i % 50)).join('\n')}\n\n`)
    const prep = `
def prepare(data):
    raw = data["M1"]["delay"]
    delays = raw.dropna()
    return {"delays": delays, "report": {"steps": [{"step": "keep recorded delays", "rows_before": int(raw.size), "rows_after": int(delays.size), "note": "blank rows dropped"}], "definitions": ["delays are in ms"]}}

def p95(x):
    return float(x.quantile(0.95))`
    const checked = await runPreparation(python!, join(dir, 'preparation'), prep, { M1: join(dir, 'm1.csv') })
    expect(checked).toEqual({ ok: true, report: { steps: [{ step: 'keep recorded delays', rows_before: 200, rows_after: 200, note: 'blank rows dropped' }], definitions: ['delays are in ms'] } })
    const run = await runAnalysis(python!, join(dir, 'P1'), 'def run(prepared, data):\n    d = prepared["delays"]\n    return {"results": [{"name": "p95", "value": p95(d), "unit": "ms", "n": int(d.size), "method": "sample quantile"}], "checks": []}', { M1: join(dir, 'm1.csv') }, prep)
    expect(run.results).toEqual([{ name: 'p95', value: 147, unit: 'ms', n: 200, method: 'sample quantile' }])
  })
})
