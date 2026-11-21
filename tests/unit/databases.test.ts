// A database a paper draws on: one line connects it, every query is read-only
// and bounded, and the extracts the analyses need become private datasets.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractData } from '../../src/engine/behaviors/data.js'
import { parseConnectionLine, query, saveConnection } from '../../src/engine/databases.js'
import { Paper } from '../../src/engine/paper.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'galley-test-')); process.env.GALLEY_CONNECTIONS = join(dir, 'connections.json') })
afterEach(() => { vi.unstubAllGlobals(); delete process.env.GALLEY_CONNECTIONS; rmSync(dir, { recursive: true, force: true }) })

describe('connecting a database', () => {
  it('reads one line: a server reached over SSH, or a ClickHouse address with its credentials', () => {
    expect(parseConnectionLine('root@37.27.112.167')).toEqual({ via: 'ssh', host: 'root@37.27.112.167' })
    expect(parseConnectionLine('clickhouse://reader:s3cret@db.example.org/trades')).toEqual({ via: 'http', url: 'http://db.example.org:8123', user: 'reader', password: 's3cret', database: 'trades' })
    expect(parseConnectionLine('https://db.example.org:8443')).toEqual({ via: 'http', url: 'https://db.example.org:8443' })
    expect(() => parseConnectionLine('not a connection!')).toThrow()
  })

  it('runs every query read-only, bounded in time and rows, whatever the SQL asks', async () => {
    const calls: { url: string; body: string; auth: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: init.body, auth: init.headers.Authorization ?? '' })
      return new Response('"day","trades"\n"2026-11-20",1670735\n')
    }))
    const csv = await query({ via: 'http', url: 'http://db.example.org:8123', user: 'reader', password: 's3cret' }, 'origo', 'SELECT toDate(datetime) AS day, count() AS trades FROM t GROUP BY day;')
    expect(csv).toContain('1670735')
    const params = new URL(calls[0].url).searchParams
    expect(Object.fromEntries(params)).toMatchObject({ database: 'origo', readonly: '1', max_execution_time: '300', max_result_rows: '1000000', result_overflow_mode: 'throw' })
    expect(calls[0].body).toBe('SELECT toDate(datetime) AS day, count() AS trades FROM t GROUP BY day FORMAT CSVWithNames')
    expect(calls[0].auth).toBe(`Basic ${Buffer.from('reader:s3cret').toString('base64')}`)
  })
})

describe('extracting from a database', () => {
  it('runs the extracts the plan needs, refuses one that sets its own limits, and keeps each table as a private dataset', async () => {
    saveConnection({ name: 'origo on db.example.org', kind: 'clickhouse', via: 'http', url: 'http://db.example.org:8123', user: 'reader', password: 's3cret', database: 'origo' })
    const paper = Paper.create(join(dir, 'p'), 'seed', { datasets: [{ id: 'D1', name: 'origo', materials: [], producedBy: 'others', private: true, connection: 'origo on db.example.org', database: 'origo', schemaFile: 'materials/D1-schema.json' }] })
    mkdirSync(paper.path('materials'), { recursive: true })
    writeFileSync(paper.path('materials', 'D1-schema.json'), JSON.stringify({ version: '26.8', database: 'origo', tables: [{ table: 'trades', rows: 8e9, bytes: 1.4e11, columns: ['datetime DateTime64(6)', 'price Float64'] }] }))
    paper.state.analysis = { field: 'market microstructure', conventions: [], preparation: [], plan: [{ id: 'P1', claims: [], question: 'Daily trade counts', method: 'count', uncertainty: 'none', assumptions: [], checks: [], datasets: ['D1'] }], mode: 'code', reviewed: { family: 'gpt', notes: [] } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('"day","trades"\n"2026-11-19",3623949\n"2026-11-20",1670735\n')))
    const answers = [
      { extracts: [{ id: 'E1', database: 'D1', purpose: 'daily trade counts for P1', sql: 'SELECT toDate(datetime) AS day, count() AS trades FROM trades GROUP BY day' }, { id: 'E2', database: 'D1', purpose: 'raw prices', sql: 'SELECT price FROM trades SETTINGS max_result_rows = 0' }] },
      { extracts: [{ id: 'E2', database: 'D1', purpose: 'mean price by day', sql: 'SELECT toDate(datetime) AS day, avg(price) AS price FROM trades GROUP BY day' }] },
    ]
    const prompts: string[] = []
    paper.ask = (async (options: { prompt: string }) => { prompts.push(options.prompt); return answers.shift() }) as Paper['ask']
    await extractData.ready(paper)[0].run()

    expect(prompts[1]).toContain('E2: an extract may not set its own settings')
    const extracts = paper.state.analysis!.extracts!
    expect(extracts.map((e) => [e.id, e.ok, e.rows])).toEqual([['E1', true, 2], ['E2', true, 2]])
    expect(paper.config.materials?.map((m) => [m.id, m.kind, m.dataset, m.private])).toEqual([['M1', 'dataset', 'D1', true], ['M2', 'dataset', 'D1', true]])
    expect(JSON.parse(readFileSync(paper.path('paper.json'), 'utf8')).datasets[0].materials).toEqual(['M1', 'M2'])
    expect(readFileSync(paper.path(paper.config.materials![0].file!), 'utf8')).toContain('3623949')
  })
})
