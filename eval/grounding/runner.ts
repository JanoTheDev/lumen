// Offline grounding eval (plans/10-quality/eval-spec.md): loads cases.jsonl + fixtures, runs a
// strategy per case, scores hits and writes a markdown report. No live agent, no screen: the
// fixtures are UIA trees, OCR words and geometry (synthetic until real captures exist).
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ElementNode, MonitorInfo, Rect, Target } from '@shared/types'
import type { OcrResult, UiaSnapshotResult } from '../../src/main/agent/commands'
import { frameGeometryOf, type ScreenAdapter } from '../../src/main/actions/coords'
import type { GroundingContext } from '../../src/main/query/resolve-target'

export const GROUNDING_DIR = __dirname

export type Category = 'text-label' | 'icon-only' | 'ordinal' | 'spatial' | 'canvas' | 'ambiguous'

export interface Case {
  id: string
  fixture: string
  query: string
  intent: 'click' | 'locate' | 'type-into' | 'hover'
  /** The target the model would answer with (offline stand-in for the model call); null = none. */
  modelTarget?: Target | null
  expected: { none: true } | { elementIds?: string[]; rects: Rect[] }
  category: Category
  uiaQuality: 'good' | 'partial' | 'none'
  difficulty: 1 | 2 | 3
  notes?: string
}

export interface Meta {
  app: string
  monitor: { id: number; x: number; y: number; w: number; h: number; scaleFactor: number }
  window?: { title: string; process: string; rect: Rect }
  frame: { w: number; h: number; downscaled?: { w: number; h: number } }
}

export interface Fixture {
  meta: Meta
  uia?: UiaSnapshotResult
  ocr?: OcrResult
}

export interface Output {
  /** Physical px, monitor-relative (like the expected rects). */
  rect?: Rect
  elementId?: string
  none?: boolean
  confidence: number
  latencyMs: number
  costUsd: number
  modelCalls: number
  debug?: string
}

export type Strategy = (c: Case, fx: Fixture) => Promise<Output>

export interface Result {
  case: Case
  app: string
  strategy: string
  out: Output
  hit: boolean
}

const readJson = <T>(p: string): T | undefined =>
  existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined

export function loadCases(file = join(GROUNDING_DIR, 'cases.jsonl')): Case[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as Case
      } catch {
        throw new Error(`cases.jsonl line ${i + 1} is not JSON`)
      }
    })
}

/** Schema problems in a case (eval-spec §3), empty when valid. */
export function validateCase(c: Case, fixtureExists: (f: string) => boolean): string[] {
  const errs: string[] = []
  if (!c.id || !/^[a-z0-9-]+$/.test(c.id)) errs.push('id must be kebab-case')
  if (!c.query?.trim()) errs.push('query is empty')
  if (!fixtureExists(c.fixture)) errs.push(`fixture ${c.fixture} not found`)
  if (!('none' in c.expected)) {
    if (!c.expected.rects?.length) errs.push('at least one expected rect is required')
    if (c.category === 'ordinal' && c.expected.rects.length !== 1)
      errs.push('ordinal cases need exactly one answer')
  }
  return errs
}

export function loadFixture(name: string, root = join(GROUNDING_DIR, 'fixtures')): Fixture {
  const dir = join(root, name)
  const meta = readJson<Meta>(join(dir, 'meta.json'))
  if (!meta) throw new Error(`fixture ${name}: meta.json missing`)
  const uia = readJson<UiaSnapshotResult | Record<string, never>>(join(dir, 'uia.json'))
  return {
    meta,
    ...(uia && 'root' in uia ? { uia: uia as UiaSnapshotResult } : {}),
    ...(existsSync(join(dir, 'ocr.json'))
      ? { ocr: readJson<OcrResult>(join(dir, 'ocr.json')) }
      : {})
  }
}

export function fixtureExists(name: string, root = join(GROUNDING_DIR, 'fixtures')): boolean {
  return existsSync(join(root, name, 'meta.json'))
}

/** A one-monitor DIP <-> physical adapter for the fixture's monitor. */
export function adapterFor(meta: Meta): ScreenAdapter {
  const { x, y, scaleFactor: s } = meta.monitor
  return {
    screenToDipPoint: (p) => ({ x: x + (p.x - x) / s, y: y + (p.y - y) / s }),
    dipToScreenPoint: (p) => ({
      x: Math.round(x + (p.x - x) * s),
      y: Math.round(y + (p.y - y) * s)
    }),
    screenToDipRect: (r) => ({
      x: x + (r.x - x) / s,
      y: y + (r.y - y) / s,
      width: r.width / s,
      height: r.height / s
    })
  }
}

function shift<T extends { rect: Rect; children?: T[] }>(n: T, dx: number, dy: number): T {
  return {
    ...n,
    rect: { ...n.rect, x: n.rect.x + dx, y: n.rect.y + dy },
    ...(n.children ? { children: n.children.map((c) => shift(c, dx, dy)) } : {})
  }
}

/** The resolver's context for a fixture: frame "1", absolute physical UIA/OCR rects. */
export function contextFor(fx: Fixture): GroundingContext {
  const m = fx.meta.monitor
  const monitor: MonitorInfo = {
    id: m.id,
    rect: { x: m.x, y: m.y, w: m.w, h: m.h },
    scale: m.scaleFactor,
    primary: true
  }
  const img = fx.meta.frame.downscaled ?? { w: fx.meta.frame.w, h: fx.meta.frame.h }
  const ocr = fx.ocr && {
    words: fx.ocr.words.map((w) => shift(w, m.x, m.y)),
    lines: fx.ocr.lines.map((l) => shift(l, m.x, m.y))
  }
  const win = fx.meta.window?.rect
  return {
    frames: [
      { label: '1', monitor, geometry: frameGeometryOf({ width: img.w, height: img.h, monitor }) }
    ],
    ...(win ? { foreground: { rect: { ...win, x: win.x + m.x, y: win.y + m.y } } } : {}),
    ...(fx.uia
      ? { uia: { snapshotId: fx.uia.snapshotId, root: shift<ElementNode>(fx.uia.root, m.x, m.y) } }
      : {}),
    ...(ocr ? { ocr: async () => ocr } : {})
  }
}

const grow = (r: Rect, d: number): Rect => ({
  x: r.x - d,
  y: r.y - d,
  w: r.w + 2 * d,
  h: r.h + 2 * d
})
const contains = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

/** eval-spec §5: centre inside an expected rect grown by 4 px, or a listed element id. */
export function score(c: Case, out: Output): boolean {
  if ('none' in c.expected) return !!out.none || !out.rect || out.confidence < 0.3
  if (out.elementId && c.expected.elementIds?.includes(out.elementId)) return true
  if (!out.rect) return false
  const cx = out.rect.x + out.rect.w / 2
  const cy = out.rect.y + out.rect.h / 2
  return c.expected.rects.some((r) => contains(grow(r, 4), cx, cy))
}

export async function run(
  strategies: Record<string, Strategy>,
  cases: Case[],
  load: (name: string) => Fixture = loadFixture
): Promise<Result[]> {
  const fixtures = new Map<string, Fixture>()
  const results: Result[] = []
  for (const c of cases) {
    if (!fixtures.has(c.fixture)) fixtures.set(c.fixture, load(c.fixture))
    const fx = fixtures.get(c.fixture)!
    for (const [name, strategy] of Object.entries(strategies)) {
      const out = await strategy(c, fx)
      results.push({ case: c, app: fx.meta.app, strategy: name, out, hit: score(c, out) })
    }
  }
  return results
}

const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : '–')

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

function table(results: Result[], key: (r: Result) => string, label: string): string[] {
  const groups = new Map<string, Result[]>()
  for (const r of results) {
    const k = `${r.strategy}\u0000${key(r)}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  return [
    `| strategy | ${label} | cases | hit | hit @ conf ≥ 0.7 | coverage | p50 ms | $ / case |`,
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(([k, rs]) => {
      const [strategy, group] = k.split('\u0000')
      const confident = rs.filter((r) => r.out.confidence >= 0.7 && !r.out.none)
      const covered = rs.filter((r) => !r.out.none && r.out.rect)
      const cost = rs.reduce((n, r) => n + r.out.costUsd, 0) / rs.length
      return `| ${strategy} | ${group} | ${rs.length} | ${pct(rs.filter((r) => r.hit).length, rs.length)} | ${pct(confident.filter((r) => r.hit).length, confident.length)} | ${pct(covered.length, rs.length)} | ${median(rs.map((r) => r.out.latencyMs)).toFixed(1)} | ${cost.toFixed(4)} |`
    })
  ]
}

export function hitRate(results: Result[], strategy: string): number {
  const rs = results.filter((r) => r.strategy === strategy)
  return rs.length ? rs.filter((r) => r.hit).length / rs.length : 0
}

export function formatReport(results: Result[], info: { date: string; sha: string }): string {
  const failures = results.filter((r) => !r.hit).slice(0, 20)
  const rect = (r?: Rect): string => (r ? `${r.x},${r.y} ${r.w}x${r.h}` : 'none')
  const expected = (c: Case): string =>
    'none' in c.expected ? 'none' : c.expected.rects.map((r) => rect(r)).join(' / ')
  return [
    `# Grounding eval ${info.date} (${info.sha})`,
    '',
    'Offline run over eval/grounding/cases.jsonl. Rects are physical px, monitor-relative.',
    '',
    '## Summary',
    '',
    ...table(results, () => 'all', 'scope'),
    '',
    '## Per app',
    '',
    ...table(results, (r) => r.app, 'app'),
    '',
    '## Per category',
    '',
    ...table(results, (r) => r.case.category, 'category'),
    '',
    '## Failures',
    '',
    ...(failures.length
      ? [
          '| strategy | case | query | expected | got | conf |',
          '| --- | --- | --- | --- | --- | ---: |',
          ...failures.map(
            (f) =>
              `| ${f.strategy} | ${f.case.id} | ${f.case.query} | ${expected(f.case)} | ${rect(f.out.rect)}${f.out.debug ? ` (${f.out.debug})` : ''} | ${f.out.confidence.toFixed(2)} |`
          )
        ]
      : ['None.'])
  ].join('\n')
}
