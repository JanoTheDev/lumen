/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// Hands-on probe of the installed `claude` CLI for the Claude Code copilot (stream 08 T32).
// Each probe is one tiny headless run (haiku, trivial prompt) in a fresh empty temp dir; it
// uses the user's own quota, so run only what you need:
//   node scripts/probe-claude.mjs multiturn   stream-json input: two user turns on one process
//   node scripts/probe-claude.mjs hooks       http PermissionRequest / PreToolUse / Notification /
//                                             Stop hooks + AskUserQuestion, via --settings
//   node scripts/probe-claude.mjs interrupt   control_request interrupt mid-turn, then a new turn
// Never touches ~/.claude/settings.json: hooks go in a per-run --settings file.
import { spawn, execFileSync } from 'child_process'
import { createServer } from 'http'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

const probe = process.argv[2]
if (!['multiturn', 'hooks', 'interrupt'].includes(probe)) {
  console.error('usage: node scripts/probe-claude.mjs multiturn|hooks|interrupt')
  process.exit(2)
}

function findClaude() {
  try {
    return execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
  } catch {
    return 'claude'
  }
}

const t0 = Date.now()
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`
const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? '')
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function userLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
}

function summarize(ev) {
  if (ev.type === 'system' && ev.subtype === 'init')
    return `system/init mode=${ev.permissionMode} tools=${short(ev.tools, 1500)} slash=${short(ev.slash_commands, 600)} keys=${Object.keys(ev).join(',')}`
  if (ev.type === 'system') return `system/${ev.subtype} ${short(ev.session_id ?? '')}`
  if (ev.type === 'stream_event') return `stream_event ${ev.event?.type}`
  if (ev.type === 'assistant' || ev.type === 'user') {
    const parts = (ev.message?.content ?? []).map((c) =>
      c.type === 'text'
        ? `text:${short(c.text, 120)}`
        : c.type === 'tool_use'
          ? `tool_use:${c.name} ${short(c.input, 200)}`
          : c.type === 'tool_result'
            ? `tool_result:${short(c.content, 200)}`
            : c.type
    )
    return `${ev.type} ${parts.join(' | ') || short(ev.message?.content, 120)}`
  }
  if (ev.type === 'result')
    return `result ${ev.subtype} turns=${ev.num_turns} cost=${ev.total_cost_usd} ${short(ev.result, 120)}`
  return short(ev, 400)
}

function run(args, cwd, onEvent) {
  const exe = findClaude()
  console.log(`${ms()} spawn ${exe} ${args.join(' ')}`)
  const child = spawn(exe, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        console.log(`${ms()} [non-json] ${short(line)}`)
        continue
      }
      if (ev.type !== 'stream_event') console.log(`${ms()} < ${summarize(ev)}`)
      onEvent(ev, child)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => console.log(`${ms()} [stderr] ${short(d.trim())}`))
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      console.log(`${ms()} exit code=${code} signal=${signal}`)
      resolve(code)
    })
  )
  return { child, exited }
}

const BASE = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--model',
  'haiku',
  '--no-session-persistence'
]

const cwd = mkdtempSync(join(tmpdir(), 'lumen-probe-'))
console.log(`${ms()} cwd ${cwd}`)

async function multiturn() {
  let results = 0
  const { child, exited } = run([...BASE, '--permission-mode', 'dontAsk'], cwd, (ev, c) => {
    if (ev.type !== 'result') return
    results++
    if (results === 1) {
      console.log(`${ms()} > second turn`)
      c.stdin.write(userLine('Reply with exactly: TWO'))
    } else c.stdin.end()
  })
  console.log(`${ms()} > first turn`)
  child.stdin.write(userLine('Reply with exactly: OK'))
  setTimeout(() => child.kill(), 90_000)
  await exited
}

async function hooks() {
  const token = randomBytes(16).toString('hex')
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const auth = req.headers['x-lumen-token'] === token
      let p = {}
      try {
        p = JSON.parse(body)
      } catch {
        /* ignore */
      }
      console.log(
        `${ms()} HOOK ${req.url} auth=${auth} event=${p.hook_event_name} tool=${p.tool_name ?? ''} keys=${Object.keys(p).join(',')}`
      )
      console.log(`${ms()}      ${short(p, 900)}`)
      let out = {}
      if (p.hook_event_name === 'PermissionRequest')
        out = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision:
              p.tool_name === 'AskUserQuestion'
                ? { behavior: 'allow', updatedInput: answerQuestions(p.tool_input) }
                : { behavior: 'allow' }
          }
        }
      if (p.hook_event_name === 'PreToolUse' && p.tool_name === 'AskUserQuestion')
        out = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: answerQuestions(p.tool_input)
          }
        }
      console.log(`${ms()}      -> ${short(out)}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const hook = (path) => [
    {
      matcher: '*',
      hooks: [
        {
          type: 'http',
          url: `http://127.0.0.1:${port}/${path}`,
          headers: { 'X-Lumen-Token': token },
          timeout: 30
        }
      ]
    }
  ]
  const settingsFile = join(cwd, '..', `lumen-probe-settings-${process.pid}.json`)
  writeFileSync(
    settingsFile,
    JSON.stringify({
      hooks: {
        PreToolUse: hook('pre'),
        PermissionRequest: hook('perm'),
        Notification: hook('notify'),
        Stop: hook('stop')
      }
    })
  )
  const { child, exited } = run(
    [...BASE, '--permission-mode', 'manual', '--settings', settingsFile],
    cwd,
    (ev, c) => {
      if (ev.type === 'control_request') {
        console.log(`${ms()} control_request ${short(ev, 900)}`)
        c.stdin.write(
          JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: ev.request_id,
              response: { behavior: 'allow', updatedInput: ev.request?.input ?? {} }
            }
          }) + '\n'
        )
      }
      if (ev.type === 'result') c.stdin.end()
    }
  )
  child.stdin.write(
    userLine(
      'Do these steps: 1) use the Write tool to create the file note.txt containing: hi. ' +
        '2) use the AskUserQuestion tool to ask me whether I prefer red or blue (two options). ' +
        '3) reply with my answer, nothing else.'
    )
  )
  setTimeout(() => child.kill(), 120_000)
  await exited
  server.close()
  rmSync(settingsFile, { force: true })
}

function answerQuestions(input) {
  const answers = {}
  for (const q of input?.questions ?? []) answers[q.question] = q.options?.[1]?.label ?? 'Blue'
  return { ...input, answers }
}

async function interrupt() {
  let interrupted = false
  let results = 0
  let sessionId
  const { child, exited } = run(
    [...BASE, '--permission-mode', 'dontAsk', '--include-partial-messages'],
    cwd,
    (ev, c) => {
      if (ev.session_id) sessionId = ev.session_id
      if (!interrupted && ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
        interrupted = true
        console.log(`${ms()} > control_request interrupt`)
        c.stdin.write(
          JSON.stringify({
            type: 'control_request',
            request_id: 'int-1',
            request: { subtype: 'interrupt' }
          }) + '\n'
        )
      }
      if (ev.type === 'control_response') console.log(`${ms()} control_response ${short(ev)}`)
      if (ev.type === 'result') {
        results++
        if (results === 1) {
          console.log(`${ms()} > follow-up turn after interrupt`)
          c.stdin.write(userLine('Reply with exactly: AFTER'))
        } else c.stdin.end()
      }
    }
  )
  child.stdin.write(userLine('Write the numbers from 1 to 300, one per line, nothing else.'))
  setTimeout(() => child.kill(), 90_000)
  await exited
  console.log(`${ms()} session ${sessionId}`)
}

try {
  if (probe === 'multiturn') await multiturn()
  if (probe === 'hooks') await hooks()
  if (probe === 'interrupt') await interrupt()
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
