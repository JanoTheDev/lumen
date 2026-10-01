// Log hygiene: no API keys or other secrets reach the console or main.log, and no log call in
// main passes a key, password or image payload. Unit tests of each redactor are in
// agent-mode/redact.test.ts and packaging/diagnostics.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { format } from 'util'
import { log } from '../src/main/logger'
import { redact as redactFile } from '../src/main/diagnostics/log-file'

const ANTHROPIC = 'sk-ant-api03-Zx9_abcDEF0123456789ghiJKLmnopQRSTuvwxYZ-AA'
const OPENAI = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const OPENAI_OLD = 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd'
const BEARER = 'abcdefghijklmnopqrstuvwxyz012345'
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
const SECRETS = [ANTHROPIC, OPENAI, OPENAI_OLD, BEARER, JWT]

/** Lines shaped like real log output that happen to carry a secret. */
const LINES = [
  `[ai] anthropic request failed: 401 invalid x-api-key ${ANTHROPIC}`,
  `[keys] loaded ANTHROPIC_API_KEY=${ANTHROPIC} from .env`,
  `OpenAI error: Incorrect API key provided: ${OPENAI}.`,
  `legacy key ${OPENAI_OLD}`,
  `headers: { Authorization: 'Bearer ${BEARER}' }`,
  `{"apiKey":"${OPENAI}","model":"gpt-5"}`,
  `typing "${ANTHROPIC}" into Notepad`
]
const JWT_LINE = `[bridge] non-JSON from agent: token=${JWT}`

const leaks = (text: string): string[] => SECRETS.filter((s) => text.includes(s))

afterEach(() => vi.restoreAllMocks())

describe('redaction over representative log lines', () => {
  it.each(LINES)('log() never prints the secret: %s', (line) => {
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((l: string) => void out.push(l))
    log('fail', line)
    expect(out).toHaveLength(1)
    expect(leaks(out[0])).toEqual([])
    // main.log gets the console line through the file tee's own filter as well.
    expect(leaks(redactFile(out[0]))).toEqual([])
  })

  it.each(LINES)('a raw console.* line is filtered before main.log: %s', (line) => {
    // console.error('[x] failed:', err.message) → util.format → redact → file.
    const written = redactFile(format('[x] failed:', line))
    expect(leaks(written)).toEqual([])
  })

  it('log() redacts a JWT', () => {
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((l: string) => void out.push(l))
    log('fail', JWT_LINE)
    expect(leaks(out[0])).toEqual([])
  })

  // The main.log tee only knows key-shaped strings (sk-, Bearer, api_key=), so a JWT printed
  // with console.* (the bridge logs non-JSON agent lines that way) reaches the file.
  // See 10-quality/tasks.md Notes: log-file.ts should reuse ai/memory/sensitive redact().
  it.fails('a raw console.* JWT is filtered before main.log', () => {
    expect(leaks(redactFile(format(JWT_LINE)))).toEqual([])
  })

  it('leaves ordinary lines untouched', () => {
    const plain = [
      '[bridge] agent ready: native 0.4.1',
      'execute: click, type | image 1280x720 → phys 2560x1440',
      '[hotkey] Ctrl+Shift+Space registered',
      'turn {"mode":"answer","totalMs":2410,"promptChars":42}'
    ]
    for (const p of plain) expect(redactFile(p)).toBe(p)
  })
})

// ---- static scan of log call sites ----

const ROOT = join(__dirname, '..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** The argument text of every console.* / log() call, joined over continuation lines. */
function logCalls(file: string): { at: string; args: string }[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const calls: { at: string; args: string }[] = []
  const start = /\b(?:console\.(?:log|info|warn|error|debug)|(?<![.\w])log)\(/
  lines.forEach((line, i) => {
    const m = start.exec(line)
    if (!m) return
    let text = line.slice(m.index + m[0].length)
    let depth = 1
    let j = i
    for (;;) {
      for (const c of text) {
        if (c === '(') depth++
        else if (c === ')') depth--
      }
      if (depth <= 0 || j - i >= 6 || j + 1 >= lines.length) break
      j++
      text += '\n' + lines[j]
    }
    calls.push({ at: `${relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}`, args: text })
  })
  return calls
}

const FORBIDDEN: [RegExp, string][] = [
  [/\bprocess\.env\.\w*(KEY|TOKEN|SECRET)\w*/i, 'environment secret'],
  [
    /\$\{[^}]*\b(api_?key|apiKeys?|secret|password|accessToken|authToken)\b[^}]*\}/i,
    'secret value'
  ],
  [/,\s*(api_?key|apiKey|secret|password|accessToken|authToken)\s*[,)]/i, 'secret value'],
  [/\b(getKey|readVault|decryptString)\(/, 'secret lookup'],
  [/\$\{[^}]*\b(base64|dataUrl|jpeg|png|imageData|frameData|pcm)\b[^}]*\}/i, 'image or audio data'],
  [/,\s*(base64|dataUrl|imageData|frameData|pcm)\s*[,)]/i, 'image or audio data']
]

describe('log call sites in src/main and src/preload', () => {
  const files = [...sources(join(ROOT, 'src/main')), ...sources(join(ROOT, 'src/preload'))]
  const calls = files.flatMap(logCalls)

  it('finds the log calls (scanner sanity check)', () => {
    expect(calls.length).toBeGreaterThan(200)
  })

  it('never log a key, password, or raw image / audio data', () => {
    const hits: string[] = []
    for (const c of calls)
      for (const [re, what] of FORBIDDEN) if (re.test(c.args)) hits.push(`${c.at} (${what})`)
    expect(hits).toEqual([])
  })
})
