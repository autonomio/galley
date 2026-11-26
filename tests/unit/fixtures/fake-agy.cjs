#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const at = (flag) => args[args.indexOf(flag) + 1]
const conversation = '9fbc0ad4-4f6c-4d04-9f58-54deacca9532'
const transcript = path.join(process.env.HOME, '.gemini/antigravity-cli/brain', conversation, '.system_generated/logs/transcript_full.jsonl')
fs.mkdirSync(path.dirname(transcript), { recursive: true })
const emit = (event) => console.log(JSON.stringify(event))
const usage = { input_tokens: 11, cache_read_tokens: 2, output_tokens: 3, thinking_tokens: 1 }
const resumed = args.includes('--conversation')
if (resumed) {
  if (at('--conversation') !== conversation || !at('--print').includes('stream was interrupted')) process.exit(7)
  emit({ event: 'result', result: { status: 'SUCCESS', response: '', structured_output: { result_json: process.env.FAKE_VALUE }, usage } })
} else if (args.includes('--print')) {
  const manifest = JSON.parse(at('--print'))
  const lines = []
  emit({ event: 'init', conversation_id: conversation })
  manifest.available_files.forEach((file, i) => {
    const step_index = i + 1
    const data = fs.readFileSync(file.path, 'utf8')
    emit({ step_update: { step_type: 'tool', step_index, state: 'DONE', conversation_id: conversation, tool_info: { name: 'view_file', parameters: { AbsolutePath: file.path } } } })
    lines.push(JSON.stringify({ type: 'GENERIC', status: 'DONE', source: 'MODEL', step_index, content: `Showing lines 1-1 of 1\n1: ${data}\n(no newline at end of file)` }))
  })
  fs.writeFileSync(transcript, lines.join('\n') + '\n')
  if (process.env.FAKE_INTERRUPT === 'yes') emit({ event: 'result', result: { status: 'ERROR', error: 'stream was interrupted' } })
  else emit({ event: 'result', result: { status: 'SUCCESS', response: '', structured_output: { result_json: process.env.FAKE_VALUE }, usage } })
} else {
  fs.readFileSync(0, 'utf8')
  fs.writeFileSync(transcript, JSON.stringify({ type: 'USER_INPUT', content: '<truncated 7 bytes>' }))
  emit({ event: 'init', conversation_id: conversation })
  emit({ event: 'result', result: { status: 'SUCCESS', structured_output: { value: 'truncated' }, usage } })
}
