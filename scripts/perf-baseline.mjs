/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// Latency + cost baseline from the app's own log: every finished turn writes
// `[time] turn {json}` (src/main/ai/turn-metrics.ts) and the router `[time] router Nms`.
// Prints p50/p95 per mode as markdown. Reads main.log and its rotated copies by default.
//   npm run perf:baseline                       (%APPDATA%/Lumen/logs)
//   npm run perf:baseline -- <file or dir> [--last N]
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'

const TURN_RE = /\[time\]\s+turn (\{.*\})/
const ROUTER_RE = /\[time\]\s+router (\d+)ms/

/** Turn records and router latencies found in log text, oldest first. */
export function parseLog(text) {
  const turns = []
  const router = []
  for (const line of text.split(/\r?\n/)) {
    const t = TURN_RE.exec(line)
    if (t) {
      try {
        const r = JSON.parse(t[1])
        if (typeof r.totalMs === 'number') turns.push(r)
      } catch {
        // a torn or foreign line
      }
      continue
    }
    const r = ROUTER_RE.exec(line)
    if (r) router.push(Number(r[1]))
  }
  return { turns, router }
}

export function percentile(values, p) {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b)
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}

const METRICS = ['speechToQueryMs', 'firstByteMs', 'totalMs', 'inputTokens', 'outputTokens', 'usd']

function stats(turns) {
  const out = { n: turns.length }
  for (const m of METRICS) {
    const values = turns.map((t) =>
      m === 'inputTokens'
        ? t.inputTokens + (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0)
        : t[m]
    )
    out[m] = { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
  }
  return out
}

/** p50/p95 per mode (done turns only) plus overall, and the router's own latency. */
export function summarize({ turns, router }, last = Infinity) {
  const recent = turns.slice(-last)
  const done = recent.filter((t) => t.outcome === 'done')
  const modes = [...new Set(done.map((t) => t.mode))].sort()
  return {
    turns: recent.length,
    failed: recent.filter((t) => t.outcome === 'failed').length,
    cancelled: recent.filter((t) => t.outcome === 'cancelled').length,
    byMode: Object.fromEntries(modes.map((m) => [m, stats(done.filter((t) => t.mode === m))])),
    all: stats(done),
    router: { n: router.length, p50: percentile(router, 0.5), p95: percentile(router, 0.95) },
    usd: done.reduce((s, t) => s + (t.usd ?? 0), 0)
  }
}

const ms = (v) => (v === null ? '-' : `${Math.round(v)}`)
const pair = (s, f = ms) => `${f(s.p50)} / ${f(s.p95)}`
const usd = (v) => (v === null ? '-' : `$${v.toFixed(4)}`)

export function formatMarkdown(s) {
  const head =
    '| mode | n | speech→query ms | query→first byte ms | total ms | tokens in | tokens out | $ / turn |'
  const rows = [...Object.entries(s.byMode), ['**all**', s.all]].map(
    ([mode, x]) =>
      `| ${mode} | ${x.n} | ${pair(x.speechToQueryMs)} | ${pair(x.firstByteMs)} | ${pair(x.totalMs)} | ${pair(x.inputTokens)} | ${pair(x.outputTokens)} | ${pair(x.usd, usd)} |`
  )
  return [
    `Turns: ${s.turns} (${s.failed} failed, ${s.cancelled} cancelled) · total $${s.usd.toFixed(4)} · values are p50 / p95`,
    '',
    head,
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Router: n ${s.router.n}, p50 ${ms(s.router.p50)} ms, p95 ${ms(s.router.p95)} ms`
  ].join('\n')
}

/** main.log plus rotated copies (oldest first) in a folder, or the one file given. */
export function readLogs(target) {
  if (!statSync(target).isDirectory()) return readFileSync(target, 'utf8')
  const files = readdirSync(target)
    .filter((n) => /^main(\.\d+)?\.log$/.test(n))
    .sort((a, b) => (Number(b.split('.')[1]) || 0) - (Number(a.split('.')[1]) || 0))
  return files.map((f) => readFileSync(join(target, f), 'utf8')).join('\n')
}

function main(argv) {
  const lastAt = argv.indexOf('--last')
  const last = lastAt >= 0 ? Number(argv[lastAt + 1]) || Infinity : Infinity
  const target =
    argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--last') ??
    join(process.env.APPDATA ?? '', 'Lumen', 'logs')
  if (!existsSync(target)) {
    console.error(`No log at ${target}. Run some turns in the app first, or pass a log path.`)
    process.exit(1)
  }
  const parsed = parseLog(readLogs(target))
  if (!parsed.turns.length) {
    console.error(`No "[time] turn" lines in ${target}.`)
    process.exit(1)
  }
  console.log(formatMarkdown(summarize(parsed, last)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
