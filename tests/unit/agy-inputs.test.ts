import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PART_LIMIT, prepareInputs, transcriptPath, truncatedBytes, verifyDelivery } from '../../src/engine/agy-inputs.js'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const conversation = '9fbc0ad4-4f6c-4d04-9f58-54deacca9532'

/** The events and transcript Antigravity leaves when the model reads each fragment whole. */
function readWhole(files: { path: string; data: Buffer }[], change?: (i: number, text: string) => string) {
  const events = files.map((file, i) => ({ step_update: { step_type: 'tool', step_index: i + 1, state: 'DONE', conversation_id: conversation, tool_info: { name: 'view_file', parameters: { AbsolutePath: file.path } } } }))
  const lines = files.map((file, i) => {
    const text = `1: ${file.data.toString('utf8')}`
    return JSON.stringify({ type: 'GENERIC', status: 'DONE', source: 'MODEL', step_index: i + 1, content: `Showing lines 1-1 of 1\n${change ? change(i, text) : text}\n(no newline at end of file)` })
  })
  const transcript = join(dir, 'transcript_full.jsonl')
  writeFileSync(transcript, lines.join('\n') + '\n')
  return { events, transcript }
}

describe('Antigravity file delivery', () => {
  it('writes a long request as one-line fragments under the reader\'s limit that rebuild it exactly, never splitting a character', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-agy-test-'))
    const prompt = `Säännöt — λ ≥ 0.\n${'x'.repeat(40_000)}\n${'ä'.repeat(30_000)}\nThe last line.`
    const { manifest, files } = prepareInputs(dir, prompt, { type: 'object' })
    expect(files.length).toBeGreaterThan(2)
    for (const file of files) {
      expect(file.data.length).toBeLessThanOrEqual(PART_LIMIT)
      expect(file.data.toString('utf8')).not.toContain('\n')
      expect(readFileSync(file.path)).toEqual(file.data)
    }
    expect(JSON.parse(Buffer.concat(files.map((f) => f.data)).toString('utf8')).request).toBe(prompt)
    const named = JSON.parse(manifest)
    expect(named.available_files.map((f: any) => f.path)).toEqual(files.map((f) => f.path))
    expect(named.response_schema).toEqual({ type: 'object' })
  })

  it('accepts a request only when every fragment reached the model whole, read by the agent itself', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-agy-test-'))
    const { files } = prepareInputs(dir, 'y'.repeat(100_000), {})
    const whole = readWhole(files)
    expect(verifyDelivery(whole.events, files, whole.transcript, conversation)).toMatchObject({ mode: 'files', parts: files.length })

    const cut = readWhole(files, (i, text) => (i === 1 ? text.slice(0, -10) : text))
    expect(verifyDelivery(cut.events, files, cut.transcript, conversation)).toMatch(/received \d+ of \d+/)

    const skipped = readWhole(files)
    expect(verifyDelivery(skipped.events.slice(1), files, skipped.transcript, conversation)).toMatch(/received \d+ of \d+/)

    const outside = readWhole(files)
    outside.events[0].step_update.tool_info.parameters.AbsolutePath = '/etc/hosts'
    expect(verifyDelivery(outside.events, files, outside.transcript, conversation)).toMatch(/outside the named input files/)

    expect(verifyDelivery(whole.events, files, join(dir, 'missing.jsonl'), conversation)).toMatch(/no transcript/)
  })

  it('finds where Antigravity cut a request off, in the user input or the planner\'s view of it', () => {
    dir = mkdtempSync(join(tmpdir(), 'galley-agy-test-'))
    const transcript = join(dir, 'transcript_full.jsonl')
    writeFileSync(transcript, [
      { type: 'USER_INPUT', content: '<USER_REQUEST>\n…baseli\n<truncated 248442 bytes>\n\nNOTE: The output was truncated because it was too long.' },
      { type: 'GENERIC', content: 'a quoted <truncated 999999 bytes> in a tool result' },
    ].map((e) => JSON.stringify(e)).join('\n'))
    expect(truncatedBytes(transcript)).toBe(248442)
    writeFileSync(transcript, JSON.stringify({ type: 'USER_INPUT', content: 'all of it' }))
    expect(truncatedBytes(transcript)).toBe(0)
    expect(truncatedBytes(null)).toBe(0)
    expect(transcriptPath('/home/u', conversation)).toBe(`/home/u/.gemini/antigravity-cli/brain/${conversation}/.system_generated/logs/transcript_full.jsonl`)
    expect(transcriptPath('/home/u', '../../etc')).toBeNull()
  })
})
