/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// Grounding fixture capture (plans/10-quality T12). Run by hand with the target app in front:
//   npm run capture:fixture -- --app gmail --name inbox [--delay 5] [--query "compose"]
//   npm run capture:fixture -- case --fixture gmail/inbox --query "write a new email" --expect e12 [--append]
// Capture: starts native/target/release/lumen-native.exe --protocol 2, counts down, then saves
// the foreground window's monitor (full-res + 1280 JPEG), OCR and a UIA snapshot of the
// foreground window to eval/grounding/fixtures/<app>/<name>/ in the runner's format (rects
// physical, monitor-relative; private-looking text masked unless --no-redact).
// Case: lists UIA candidates for --query and prints (or with --append adds) a cases.jsonl line.
// Usage and rules: eval/grounding/README.md.
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { createInterface } from 'readline'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  appendLine,
  buildCase,
  buildMeta,
  caseIds,
  caseProblems,
  convertOcr,
  convertUia,
  findCandidates,
  fixtureName,
  formatCandidates,
  frameFile,
  isTerminalProcess,
  parseArgs,
  parseRect
} from './capture-fixture-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GROUNDING = join(ROOT, 'eval', 'grounding')
const FIXTURES = join(GROUNDING, 'fixtures')
const CASES = join(GROUNDING, 'cases.jsonl')
const DEFAULT_EXE = join(ROOT, 'native', 'target', 'release', 'lumen-native.exe')

const HELP = `Grounding fixture capture (see eval/grounding/README.md)

Capture the window in front:
  npm run capture:fixture -- --app <app> --name <screen> [options]
    --delay N        seconds to switch to the target window (default 5)
    --query "..."    also list UIA candidates for this request after capture
    --max-nodes N    UIA node cap (default 400, like the app)
    --all-nodes      keep non-interactive UIA nodes too
    --no-ocr         skip OCR
    --no-redact      keep emails / key-shaped text / card numbers as captured
    --theme dark|light, --locale en-US, --app-version 1.2.3   extra meta.json fields
    --force          overwrite an existing fixture folder
    --exe <path>     lumen-native.exe (default native/target/release/lumen-native.exe)

Add a case for a saved fixture:
  npm run capture:fixture -- case --fixture <app>/<screen> --query "..." [options]
    --expect e12,e13   expected UIA element ids (from the candidate list)
    --rect x,y,w,h     expected rect, physical px relative to the monitor (repeatable via ;)
    --none             negative case: the target is not on screen
    --intent click|locate|type-into|hover   --category text-label|icon-only|ordinal|spatial|canvas|ambiguous
    --uia good|partial|none   --difficulty 1-3   --notes "..."   --id <kebab-id>
    --append           add the line to eval/grounding/cases.jsonl (else it is only printed)`

// ---- agent client (protocol v2 NDJSON, see src/main/agent/bridge.ts) ----------------------

function startAgent(exe) {
  const proc = spawn(exe, ['--protocol', '2'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const pending = new Map()
  let nextId = 1
  let onReady
  const ready = new Promise((res, rej) => {
    onReady = res
    setTimeout(() => rej(new Error('agent sent no ready event within 10 s')), 10_000).unref()
  })
  const stderr = []
  proc.stderr.on('data', (d) => stderr.push(String(d)))
  proc.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error(`agent exited (${code})`))
    pending.clear()
  })
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.event === 'ready') return onReady(msg.data ?? {})
    if (typeof msg.id !== 'number' || !pending.has(msg.id)) return
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(`${msg.error?.code ?? 'E_AGENT'}: ${msg.error?.message ?? 'failed'}`))
  })
  const request = (cmd, args = {}, timeoutMs = 15_000) =>
    new Promise((res, rej) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        rej(new Error(`${cmd} timed out`))
      }, timeoutMs + 2000)
      const settle = (fn) => (v) => {
        clearTimeout(timer)
        fn(v)
      }
      pending.set(id, { resolve: settle(res), reject: settle(rej) })
      proc.stdin.write(JSON.stringify({ v: 2, id, cmd, args: { ...args, timeoutMs } }) + '\n')
    })
  const stop = () => {
    try {
      proc.stdin.end()
    } catch {
      /* already gone */
    }
    setTimeout(() => proc.kill(), 1000).unref()
  }
  return { ready, request, stop, stderr }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function countdown(seconds) {
  for (let s = seconds; s > 0; s--) {
    process.stdout.write(`\rCapturing in ${s}... switch to the target window now `)
    await sleep(1000)
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r')
}

async function capture(opts) {
  const name = fixtureName(opts.app, opts.name)
  const dir = join(FIXTURES, ...name.split('/'))
  if (existsSync(join(dir, 'meta.json')) && !opts.force)
    throw new Error(`${name} already exists; pass --force to overwrite or pick another --name`)
  const exe = resolve(opts.exe ?? DEFAULT_EXE)
  if (!existsSync(exe)) throw new Error(`${exe} not found; run npm run build:native first`)
  const redact = opts.redact !== false
  const delay = Math.max(0, Number(opts.delay ?? 5) || 0)

  const agent = startAgent(exe)
  try {
    const info = await agent.ready
    console.log(`Agent ${info.impl ?? '?'} ${info.version ?? ''} ready.`)
    await agent.request('init', {
      hotkey: '',
      dictationHotkey: '',
      dwell: { enabled: false },
      subscriptions: [],
      logLevel: 'warn'
    })
    await countdown(delay)

    const win = await agent.request('active_window')
    if (isTerminalProcess(win.process))
      console.warn(`Warning: the window in front is ${win.process}; is that the target?`)
    const fullRes = await agent.request('capture', {
      monitor: 'foreground',
      maxWidth: 0,
      quality: 92
    })
    const full = fullRes.frames[0]
    const ocrRaw =
      opts.ocr === false
        ? undefined
        : await agent.request('ocr', { frameId: full.id }, 30_000).catch((e) => {
            console.warn(`OCR failed (${e.message}); saving without ocr.json`)
            return undefined
          })
    const small = (
      await agent.request('capture', { monitor: full.monitor.id, maxWidth: 1280, quality: 80 })
    ).frames[0]
    const uiaRaw = await agent
      .request(
        'uia_snapshot',
        {
          scope: 'foreground',
          maxNodes: Number(opts['max-nodes'] ?? 400) || 400,
          interactiveOnly: !opts['all-nodes']
        },
        20_000
      )
      .catch((e) => {
        console.warn(`UIA snapshot failed (${e.message}); saving an empty uia.json`)
        return undefined
      })

    const monitor = full.monitor
    const meta = buildMeta({
      app: opts.app,
      full,
      small,
      window: win,
      capturedAt: new Date().toISOString().slice(0, 10),
      redact,
      extra: {
        appVersion: opts['app-version'],
        theme: opts.theme,
        locale: opts.locale ?? Intl.DateTimeFormat().resolvedOptions().locale
      }
    })
    const uia = convertUia(uiaRaw, monitor, redact)
    mkdirSync(dir, { recursive: true })
    const fullFile = frameFile(full)
    const smallFile = frameFile(small)
    writeFileSync(join(dir, `frame.${fullFile.ext}`), fullFile.buffer)
    writeFileSync(join(dir, `frame_1280.${smallFile.ext}`), smallFile.buffer)
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
    writeFileSync(join(dir, 'uia.json'), JSON.stringify(uia, null, 1) + '\n')
    if (ocrRaw)
      writeFileSync(
        join(dir, 'ocr.json'),
        JSON.stringify(convertOcr(ocrRaw, monitor, redact), null, 1) + '\n'
      )

    console.log(`Saved ${name} (${win.process}, "${meta.window?.title ?? ''}")`)
    console.log(`  ${dir}`)
    console.log(
      `  frame ${full.width}x${full.height}, monitor ${monitor.id} at ${monitor.rect.x},${monitor.rect.y}, scale ${monitor.scale}`
    )
    if (opts.query && uia.root) {
      console.log(`\nUIA candidates for "${opts.query}":`)
      console.log(formatCandidates(findCandidates(uia.root, opts.query)))
      console.log(
        `\nAdd it: npm run capture:fixture -- case --fixture ${name} --query "${opts.query}" --expect <id> --append`
      )
    }
    console.log(
      `\nBefore committing: open ${join(dir, `frame.${fullFile.ext}`)} and frame_1280.${smallFile.ext} and check them for` +
        `\nprivate data (names, emails, messages, tabs, notifications). Text in uia.json / ocr.json` +
        `\nis ${redact ? 'masked for emails and key-shaped strings only' : 'NOT masked (--no-redact)'}; images are never masked.` +
        `\nDelete the folder if anything private shows.`
    )
  } catch (e) {
    if (agent.stderr.length) console.error(agent.stderr.join('').slice(-2000))
    throw e
  } finally {
    agent.stop()
  }
}

function addCase(opts) {
  const fixture = String(opts.fixture ?? '')
  const dir = join(FIXTURES, ...fixture.split('/'))
  if (!fixture || !existsSync(join(dir, 'meta.json')))
    throw new Error(`fixture "${fixture}" not found under eval/grounding/fixtures`)
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  const uiaPath = join(dir, 'uia.json')
  const uiaRoot = existsSync(uiaPath) ? JSON.parse(readFileSync(uiaPath, 'utf8')).root : undefined
  if (opts.query && uiaRoot && !opts.expect && !opts.rect && !opts.none) {
    console.log(`UIA candidates for "${opts.query}":`)
    console.log(formatCandidates(findCandidates(uiaRoot, opts.query)))
    console.log('\nPick with --expect <id>[,<id>] or give --rect x,y,w,h, then add --append.\n')
  }
  const c = buildCase({
    fixture,
    meta,
    uiaRoot,
    query: opts.query,
    id: opts.id,
    expectIds: opts.expect ? String(opts.expect).split(',').filter(Boolean) : [],
    rects: opts.rect ? String(opts.rect).split(';').filter(Boolean).map(parseRect) : [],
    none: !!opts.none,
    intent: opts.intent,
    category: opts.category,
    uiaQuality: opts.uia,
    difficulty: opts.difficulty !== undefined ? Number(opts.difficulty) : undefined,
    notes: opts.notes
  })
  const existing = existsSync(CASES) ? readFileSync(CASES, 'utf8') : ''
  const problems = caseProblems(c, caseIds(existing))
  console.log(JSON.stringify(c))
  if (problems.length) {
    console.log(`\nNot ready for cases.jsonl:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    if (opts.append) process.exitCode = 1
    return
  }
  if (opts.append) {
    appendFileSync(CASES, appendLine(existing, c))
    console.log(
      `\nAppended ${c.id} to eval/grounding/cases.jsonl. Check it: npm run eval:grounding`
    )
  } else {
    console.log('\nLooks complete. Re-run with --append to add it to eval/grounding/cases.jsonl.')
  }
}

async function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help || (!opts._.length && !opts.app)) return console.log(HELP)
  if (opts._[0] === 'case') return addCase(opts)
  if (opts._.length) throw new Error(`unknown command "${opts._[0]}" (try --help)`)
  await capture(opts)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`capture-fixture: ${e.message}`)
    process.exit(1)
  })
}
