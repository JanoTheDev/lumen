/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// Pure parts of the grounding fixture capture tool (scripts/capture-fixture.mjs): folder naming,
// monitor-relative rects, redaction of private-looking text, meta.json, candidate listing and
// the cases.jsonl line. No I/O here, so test/eval/capture-fixture.test.ts covers all of it.

/** kebab-case folder / id part: lowercase letters, digits and single dashes. */
export function slug(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** `<app>/<name>` as used by cases.jsonl `fixture`; throws on an empty part. */
export function fixtureName(app, name) {
  const a = slug(app)
  const n = slug(name)
  if (!a || !n) throw new Error('--app and --name must contain letters or digits')
  return `${a}/${n}`
}

/** Physical virtual-desktop rect -> physical rect relative to the monitor origin. */
export function toMonitorRelative(rect, monitor) {
  return { x: rect.x - monitor.rect.x, y: rect.y - monitor.rect.y, w: rect.w, h: rect.h }
}

// ---- redaction ----------------------------------------------------------------------------

const DEMO_DOMAINS = /@(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const SECRETS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, // provider API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g // JWTs
]
// A long run of letters and digits mixed (tokens, session ids); plain words are never this long.
const LONG_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g
// Card-like digit runs: 13-19 digits, optionally grouped by spaces or dashes.
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g

/** Text with emails (except example.* demo addresses), key-shaped tokens and card numbers masked. */
export function redactText(text) {
  if (typeof text !== 'string' || !text) return text
  let out = text.replace(EMAIL, (m) => (DEMO_DOMAINS.test(m) ? m : 'user@example.com'))
  for (const re of SECRETS) out = out.replace(re, '[secret]')
  return out.replace(LONG_TOKEN, '[secret]').replace(CARD, '[number]')
}

// ---- conversion of agent results to the fixture format ------------------------------------

/**
 * UIA tree with monitor-relative rects; names / values redacted unless `redact` is false.
 * Every other field (state such as `selected` / `toggled` / `expanded`) is kept as is.
 */
export function convertUiaNode(node, monitor, redact = true) {
  const fix = (s) => (redact ? redactText(s) : s)
  const out = { ...node, name: fix(node.name ?? ''), rect: toMonitorRelative(node.rect, monitor) }
  if (node.value !== undefined) out.value = fix(node.value)
  if (node.children) out.children = node.children.map((c) => convertUiaNode(c, monitor, redact))
  return out
}

export function convertUia(snapshot, monitor, redact = true) {
  if (!snapshot?.root) return {}
  return { snapshotId: snapshot.snapshotId, root: convertUiaNode(snapshot.root, monitor, redact) }
}

/** OCR words / lines with monitor-relative rects (the agent returns virtual-desktop px). */
export function convertOcr(ocr, monitor, redact = true) {
  const fix = (w) => ({
    ...w,
    text: redact ? redactText(w.text) : w.text,
    rect: toMonitorRelative(w.rect, monitor)
  })
  return { words: (ocr?.words ?? []).map(fix), lines: (ocr?.lines ?? []).map(fix) }
}

/** Base64 frame data -> { buffer, ext } (the agent encodes JPEG; PNG kept for older agents). */
export function frameFile(frame) {
  const ext = /png/i.test(frame.mime ?? '') ? 'png' : 'jpg'
  return { buffer: Buffer.from(frame.data ?? '', 'base64'), ext }
}

/** meta.json (plans/10-quality/eval-spec.md §2) from the full-res and downscaled frames. */
export function buildMeta({ app, full, small, window, capturedAt, redact = true, extra = {} }) {
  const m = full.monitor
  const meta = {
    app: slug(app),
    capturedAt,
    monitor: {
      id: m.id,
      x: m.rect.x,
      y: m.rect.y,
      w: m.rect.w,
      h: m.rect.h,
      scaleFactor: m.scale,
      primary: !!m.primary
    },
    frame: { w: full.width, h: full.height }
  }
  if (small && (small.width !== full.width || small.height !== full.height))
    meta.frame.downscaled = { w: small.width, h: small.height }
  if (window) {
    meta.window = {
      title: redact ? redactText(window.title ?? '') : (window.title ?? ''),
      process: window.process ?? '',
      rect: toMonitorRelative(window.rect, m)
    }
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') meta[k] = v
  return meta
}

// ---- annotation ---------------------------------------------------------------------------

const STOP = new Set(
  'the a an to on in of and or is it its this that for my me i where what click open press tap show find go button please'.split(
    ' '
  )
)

export function queryWords(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
}

/** Every node of a tree, depth first. */
export function flatten(root) {
  const out = []
  const walk = (n) => {
    if (!n) return
    out.push(n)
    for (const c of n.children ?? []) walk(c)
  }
  walk(root)
  return out
}

/** UIA nodes whose name / automationId share words with the query, best first. */
export function findCandidates(root, query, limit = 15) {
  const words = queryWords(query)
  if (!words.length) return []
  return flatten(root)
    .map((n) => {
      const hay = `${n.name ?? ''} ${n.automationId ?? ''}`.toLowerCase()
      const score = words.filter((w) => hay.includes(w)).length
      return { node: n, score }
    })
    .filter((c) => c.score > 0 && c.node.rect?.w > 0 && c.node.rect?.h > 0)
    .sort((a, b) => b.score - a.score || a.node.name.length - b.node.name.length)
    .slice(0, limit)
    .map(({ node }) => ({ id: node.id, role: node.role, name: node.name, rect: node.rect }))
}

export function formatCandidates(cands) {
  if (!cands.length) return '  (no UIA element matches; use --rect x,y,w,h from the image)'
  return cands
    .map(
      (c, i) =>
        `  ${String(i + 1).padStart(2)}. ${c.id.padEnd(6)} ${c.role.padEnd(12)} ${JSON.stringify(c.name)} @ ${c.rect.x},${c.rect.y} ${c.rect.w}x${c.rect.h}`
    )
    .join('\n')
}

/** "x,y,w,h" -> Rect (physical, monitor-relative). */
export function parseRect(s) {
  const p = String(s).split(',').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n)) || p[2] <= 0 || p[3] <= 0)
    throw new Error(`bad rect "${s}", expected x,y,w,h`)
  return { x: p[0], y: p[1], w: p[2], h: p[3] }
}

/** A physical monitor-relative rect in the image px of the frame the model sees ("1"). */
export function rectToImage(rect, meta) {
  const img = meta.frame.downscaled ?? meta.frame
  const s = img.w / meta.frame.w
  const r = (n) => Math.round(n * s)
  return { kind: 'rect', x: r(rect.x), y: r(rect.y), w: r(rect.w), h: r(rect.h), frame: '1' }
}

export const CATEGORIES = ['text-label', 'icon-only', 'ordinal', 'spatial', 'canvas', 'ambiguous']
export const INTENTS = ['click', 'locate', 'type-into', 'hover']

/**
 * One cases.jsonl object. Expected rects come from the picked element ids (looked up in the
 * fixture's uia tree) plus any typed rects. `modelTarget` (the offline stand-in for the model's
 * reply) is the first picked element, else the first rect in image px.
 */
export function buildCase(opts) {
  const { fixture, meta, uiaRoot, query } = opts
  const ids = opts.expectIds ?? []
  const byId = new Map(flatten(uiaRoot).map((n) => [n.id, n]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) throw new Error(`not in uia.json: ${missing.join(', ')}`)
  const rects = [...ids.map((id) => byId.get(id).rect), ...(opts.rects ?? [])]
  const none = !!opts.none
  const c = {
    id: opts.id
      ? slug(opts.id)
      : slug(`${fixture.replace('/', '-')}-${queryWords(query).join('-')}`),
    fixture,
    query: String(query ?? '').trim(),
    intent: opts.intent ?? 'click',
    modelTarget: none
      ? null
      : ids.length
        ? { kind: 'element', id: ids[0] }
        : rects.length
          ? rectToImage(rects[0], meta)
          : null,
    expected: none
      ? { none: true }
      : { ...(ids.length ? { elementIds: ids } : {}), rects: rects.map((r) => ({ ...r })) },
    category: opts.category ?? 'text-label',
    uiaQuality: opts.uiaQuality ?? (ids.length ? 'good' : 'none'),
    difficulty: opts.difficulty ?? 1
  }
  if (opts.notes) c.notes = opts.notes
  return c
}

/** Problems that keep a case out of cases.jsonl (mirrors runner.validateCase), [] when fine. */
export function caseProblems(c, existingIds = []) {
  const errs = []
  if (!c.id || !/^[a-z0-9-]+$/.test(c.id)) errs.push('id must be kebab-case')
  if (existingIds.includes(c.id)) errs.push(`id ${c.id} already in cases.jsonl (pass --id)`)
  if (!c.query) errs.push('query is empty (--query)')
  if (!INTENTS.includes(c.intent)) errs.push(`intent must be one of ${INTENTS.join(', ')}`)
  if (!CATEGORIES.includes(c.category))
    errs.push(`category must be one of ${CATEGORIES.join(', ')}`)
  if (![1, 2, 3].includes(c.difficulty)) errs.push('difficulty must be 1, 2 or 3')
  if (!('none' in c.expected)) {
    if (!c.expected.rects.length) errs.push('no expected target (--expect <ids> or --rect)')
    if (c.category === 'ordinal' && c.expected.rects.length !== 1)
      errs.push('ordinal cases need exactly one answer')
  }
  return errs
}

/** Ids already used in cases.jsonl text. */
export function caseIds(jsonl) {
  return String(jsonl ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l).id
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
}

/** Text to append to cases.jsonl so the new line starts on its own line. */
export function appendLine(existing, c) {
  const sep = existing && !existing.endsWith('\n') ? '\n' : ''
  return `${sep}${JSON.stringify(c)}\n`
}

// ---- argv ---------------------------------------------------------------------------------

/** `--key value` / `--flag` / `--no-flag` parsing; the first bare word is the command. */
export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1)
    } else if (a.startsWith('--no-')) {
      out[a.slice(5)] = false
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[++i]
    } else {
      out[a.slice(2)] = true
    }
  }
  return out
}

/** Processes the operator is likely still looking at when the countdown ends. */
export function isTerminalProcess(name) {
  return /^(windowsterminal|cmd|powershell|pwsh|conhost|wezterm-gui|alacritty|mintty)\.exe$/i.test(
    String(name ?? '')
  )
}
