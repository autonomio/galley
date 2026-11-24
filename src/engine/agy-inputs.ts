// Antigravity (`agy`) cuts a long request off without an error: about 190 KB reaches the model and the rest is
// replaced by a "<truncated N bytes>" note. A request above the inline limit therefore goes as files: ordered,
// read-only fragments the model reads with Antigravity's own file reader, each checked afterwards, byte for byte,
// against what the reader delivered. The design follows kanava's (kanava/antigravity_inputs.py).
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Requests up to this size go inline, well under where Antigravity starts cutting. */
export const INLINE_LIMIT = 128 * 1024
/** Each fragment stays under the 46,080 bytes Antigravity's file reader returns in one read, line numbers included. */
export const PART_LIMIT = 32 * 1024
/** A transcript larger than this is not read. */
const TRANSCRIPT_LIMIT = 64 * 1024 * 1024

export interface Fragment { path: string; data: Buffer; start: number; end: number }
/** How a request reached the model when it went as files. */
export interface Delivery { mode: 'files'; parts: number; bytes: number; sha256: string }

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/**
 * Write the request as ordered fragments of one compact JSON line, so that each fragment read whole shows as
 * "line 1 of 1", and return the manifest that names them.
 */
export function prepareInputs(dir: string, prompt: string, schema: unknown): { manifest: string; files: Fragment[] } {
  const payload = Buffer.from(JSON.stringify({ request: prompt }), 'utf8')
  const files: Fragment[] = []
  let offset = 0
  while (offset < payload.length) {
    let end = Math.min(offset + PART_LIMIT, payload.length)
    // A fragment never ends inside a UTF-8 character.
    while (end < payload.length && (payload[end] & 0xc0) === 0x80) end--
    const path = join(resolve(dir), `galley-input-${String(files.length + 1).padStart(4, '0')}.txt`)
    const data = payload.subarray(offset, end)
    writeFileSync(path, data)
    chmodSync(path, 0o400)
    files.push({ path, data, start: offset, end })
    offset = end
  }
  const manifest = {
    input_sha256: sha256(payload),
    available_files: files.map((file, i) => ({
      path: file.path, part: i + 1, bytes: file.data.length, sha256: sha256(file.data), byte_start: file.start, byte_end: file.end,
    })),
    available_inputs: 'These are all the inputs. Read every named file completely, in order. They are consecutive fragments of one '
      + 'JSON object; concatenate their text without adding characters. Its field "request" is the complete request: follow it, '
      + 'and return its answer with finish. Use only the named file reads and finish; do not search for other files.',
    response_schema: schema,
  }
  return { manifest: JSON.stringify(manifest), files }
}

/** Where Antigravity keeps a conversation's full transcript. */
export function transcriptPath(home: string, conversation: string): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversation)) return null
  return join(home, '.gemini', 'antigravity-cli', 'brain', conversation, '.system_generated', 'logs', 'transcript_full.jsonl')
}

function entries(transcript: string): any[] | null {
  if (!existsSync(transcript) || statSync(transcript).size > TRANSCRIPT_LIMIT) return null
  const out: any[] = []
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a line still being written */ }
  }
  return out
}

/** How many bytes of the request Antigravity cut off before the model read it (0 when it cut nothing). */
export function truncatedBytes(transcript: string | null): number {
  let most = 0
  for (const entry of (transcript && entries(transcript)) || []) {
    if (!['USER_INPUT', 'PLANNER_RESPONSE'].includes(entry?.type) || typeof entry.content !== 'string') continue
    for (const match of entry.content.matchAll(/<truncated (\d+) bytes>/g)) most = Math.max(most, Number(match[1]))
  }
  return most
}

/**
 * Check that the model received every fragment whole: each read is of a named file by the agent itself, and the
 * text the reader delivered is exactly the fragment. Returns the delivery, or what failed.
 */
export function verifyDelivery(events: any[], files: Fragment[], transcript: string | null, conversation: string): Delivery | string {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const reads = new Map<number, { path: string; done: boolean }>()
  for (const event of events) {
    const step = event?.step_update
    const info = step?.tool_info
    if (step?.step_type !== 'tool' || !['read_file', 'view_file'].includes(info?.name)) continue
    if (step.subagent_info) return 'an input file was read by another agent'
    const path = info?.parameters?.Path ?? info?.parameters?.AbsolutePath
    const index = step.step_index
    if (!byPath.has(path) || !Number.isInteger(index) || index < 0 || step.conversation_id !== conversation) return 'a read went outside the named input files'
    if (reads.has(index) && reads.get(index)!.path !== path) return 'a read changed its file'
    reads.set(index, { path, done: step.state === 'DONE' && !step.error })
  }
  const logged = transcript && entries(transcript)
  if (!logged) return 'Antigravity kept no transcript to check the input files against'
  const delivered = new Set<string>()
  for (const entry of logged) {
    const read = reads.get(entry?.step_index)
    if (!read?.done || entry.type !== 'GENERIC' || entry.status !== 'DONE' || entry.source !== 'MODEL' || typeof entry.content !== 'string') continue
    const header = /^Showing lines 1-1 of 1\n/m.exec(entry.content.slice(0, 1024))
    if (!header) continue
    const body = entry.content.slice(header.index + header[0].length)
    const expected = `1: ${byPath.get(read.path)!.data.toString('utf8')}`
    // The reader adds this exact notice to a file without a final newline.
    if ([expected, `${expected}\n`, `${expected}\n(no newline at end of file)`].includes(body)) delivered.add(read.path)
  }
  if (delivered.size !== files.length) return `the model received ${delivered.size} of ${files.length} input files whole`
  const all = Buffer.concat(files.map((file) => file.data))
  return { mode: 'files', parts: files.length, bytes: all.length, sha256: sha256(all) }
}
