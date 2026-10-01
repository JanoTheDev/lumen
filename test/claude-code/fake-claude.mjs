/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// A fake `claude -p --input-format stream-json --output-format stream-json` for tests: the event
// shapes seen in the 2026-10-01 probe (claude-code.md). Turn text drives it:
//   ASK               ends the turn with a question
//   SLOW              starts a tool and waits for an interrupt control_request
//   IGNORE_INTERRUPT  like SLOW, but never answers control requests
//   CRASH             exits 1 with a stderr line
//   anything else     "done: <text>"
// FAKE_ARGS_FILE (env): every spawn appends its argv as one JSON line.
import { appendFileSync } from 'fs'
import { randomUUID } from 'crypto'

const args = process.argv.slice(2)
if (process.env.FAKE_ARGS_FILE)
  appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify({ args, cwd: process.cwd() })}\n`)

const r = args.indexOf('--resume')
const sessionId = r >= 0 ? args[r + 1] : randomUUID()
let cost = 0
let ignoreControl = false
let waiting = null

const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`)

function init() {
  out({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ['Bash', 'Read', 'Edit'],
    slash_commands: ['code-review', 'simplify', 'compact'],
    permissionMode: 'default'
  })
}

function result(text, subtype = 'success') {
  cost += 0.01
  out({
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    num_turns: 1,
    result: text,
    session_id: sessionId,
    total_cost_usd: Number(cost.toFixed(4))
  })
}

function say(text) {
  out({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: sessionId
  })
}

function turn(text) {
  init()
  if (text === 'CRASH') {
    process.stderr.write('boom: something broke\n')
    process.exit(1)
  }
  if (text === 'ASK') {
    say('I looked at the code.\n\nShould I use tabs or spaces?')
    return result('I looked at the code.\n\nShould I use tabs or spaces?')
  }
  if (text === 'SLOW' || text === 'IGNORE_INTERRUPT') {
    ignoreControl = text === 'IGNORE_INTERRUPT'
    out({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]
      },
      session_id: sessionId
    })
    waiting = setTimeout(() => result('slow done'), 20_000)
    return
  }
  say(`done: ${text}`)
  result(`done: ${text}`)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.type === 'control_request') {
      if (ignoreControl) continue
      out({
        type: 'control_response',
        response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } }
      })
      if (waiting) {
        clearTimeout(waiting)
        waiting = null
        out({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user]' }]
          }
        })
        result('', 'error_during_execution')
      }
      continue
    }
    if (msg.type === 'user') turn(String(msg.message.content))
  }
})
process.stdin.on('end', () => process.exit(0))
