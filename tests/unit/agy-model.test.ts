import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callModel, requestKey } from '../../src/engine/models.js'
import { arr, int, obj, str } from '../../src/engine/schema.js'

let dir = ''
const spec = { family: 'gemini' as const, model: 'gemini-4-carbon-high', effort: 'high' }
const schema = obj({ value: str(), nested: arr(obj({ count: int() })) })
const valid = { value: 'ok', nested: [{ count: 3 }] }
const large = 'x'.repeat(132_000)
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'galley-agy-model-'))
  symlinkSync(resolve('tests/unit/fixtures/fake-agy.cjs'), join(dir, 'agy'))
  vi.stubEnv('HOME', dir)
  vi.stubEnv('PATH', `${dir}:${process.env.PATH}`)
  vi.stubEnv('FAKE_VALUE', JSON.stringify(valid))
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

describe('file-backed model answers', () => {
  it('resumes an interrupted file-backed conversation and validates the delivered answer', async () => {
    vi.stubEnv('FAKE_INTERRUPT', 'yes')
    const answer = await callModel({ spec, schema, prompt: large })
    expect(answer.data).toEqual(valid)
    expect(answer.delivery).toMatchObject({ mode: 'files' })
  })
  it.each([null, {}, { value: 'ok', nested: [{ count: '3' }] }, { ...valid, extra: 1 }])('rejects and never caches a schema-invalid answer: %j', async (value) => {
    vi.stubEnv('FAKE_VALUE', JSON.stringify(value))
    const cacheDir = join(dir, 'cache')
    await expect(callModel({ spec, schema, prompt: large, cacheDir })).rejects.toThrow(/schema/i)
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([])
  })
  it('retains usage from the truncated inline call and the successful file fallback', async () => {
    const answer = await callModel({ spec, schema, prompt: 'short' })
    expect(answer.data).toEqual(valid)
    expect(answer.usage).toEqual({ input: 22, cached: 4, output: 6, reasoning: 2 })
  })
  it('does not replay an invalid file-backed answer cached by an older version', async () => {
    const cacheDir = join(dir, 'cache')
    mkdirSync(cacheDir)
    writeFileSync(join(cacheDir, `${requestKey(spec, large, schema)}.json`), JSON.stringify({ data: null, delivery: { mode: 'files' } }))
    const fresh = await callModel({ spec, schema, prompt: large, cacheDir })
    expect(fresh.data).toEqual(valid)
    expect(fresh.cached).toBe(false)
    expect((await callModel({ spec, schema, prompt: large, cacheDir })).cached).toBe(true)
  })
})
