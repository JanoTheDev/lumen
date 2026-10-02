// Offline lesson-check eval (plans/10-quality T15, eval-spec §6): runs each case's `expect`
// through the production check tree (teach/checks) against a before/after state pair and
// scores the verdict against the truth. No live agent, no screen, no model: UIA snapshots,
// the foreground window, bridge state and observed events come from fixture files.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ElementNode } from '@shared/types'
import type { Clock } from '../../src/main/a11y/timings'
import type { UiaSnapshotResult } from '../../src/main/agent/commands'
import { flattenElements, isInteractive } from '../../src/main/query/uia-list'
import { blenderBridge, type BlenderClient } from '../../src/main/teach/bridges/blender'
import type { BridgeState } from '../../src/main/teach/bridges/expect'
import { OBS_REQUESTS } from '../../src/main/teach/bridges/obs'
import { makeBridgePort } from '../../src/main/teach/bridges/port'
import type { AppBridge } from '../../src/main/teach/bridges/types'
import { newBudget, startCheck } from '../../src/main/teach/checks'
import { elementHits } from '../../src/main/teach/element-hits'
import {
  checkSchema,
  parseLesson,
  type CheckSpec,
  type LessonStep
} from '../../src/main/teach/lesson'
import {
  noopPorts,
  type CheckResult,
  type UiaEvent,
  type WindowInfo
} from '../../src/main/teach/ports'

export const LESSONS_DIR = __dirname
const REPO = join(__dirname, '..', '..')

export type Truth = 'pass' | 'fail'
/** completed: the step was done. The rest are not-done variants (truth fail) or tricky positives. */
export type Category =
  | 'completed'
  | 'not-started'
  | 'similar-name'
  | 'stale-state'
  | 'partial'
  | 'wrong-control'
  | 'no-bridge'

export interface Case {
  id: string
  fixture: string
  /** State folders inside the fixture (default before / after). */
  before?: string
  after?: string
  /** "<lessonId>#<stepId>" from skills/<app>/lessons, or an inline check in `expect`. */
  step?: string
  expect?: CheckSpec
  truth: Truth
  category: Category
  notes?: string
  /** A documented gap: the note's title in plans/10-quality/tasks.md. */
  knownGap?: string
}

/** One observed thing between the before and after state (what the agent would send). */
export type ObservedEvent = UiaEvent | { combo: string }

export interface State {
  uia?: UiaSnapshotResult
  window?: WindowInfo
  /** Blender: the add-on's state; OBS: raw obs-websocket responses keyed by request name. */
  bridge?: Record<string, unknown>
  /** OCR words / lines (optional; no deterministic check reads OCR today). */
  ocr?: unknown
  events?: ObservedEvent[]
}

export interface Fixture {
  app: string
  synthetic?: boolean
  states: Record<string, State>
}

/** What a check concluded. `manual`: it passes only on the user's "done". */
export type Verdict = 'pass' | 'fail' | 'unknown' | 'manual'

export interface Output {
  verdict: Verdict
  latencyMs: number
  debug?: string
}

export type Strategy = (c: Case, check: CheckSpec, fx: Fixture) => Promise<Output>

export interface Result {
  case: Case
  app: string
  strategy: string
  out: Output
  falsePass: boolean
  falseFail: boolean
}

const readJson = <T>(p: string): T | undefined =>
  existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined

export function loadCases(file = join(LESSONS_DIR, 'cases.jsonl')): Case[] {
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

export function loadFixture(name: string, root = join(LESSONS_DIR, 'fixtures')): Fixture {
  const dir = join(root, name)
  const meta = readJson<{ app: string; synthetic?: boolean }>(join(dir, 'meta.json'))
  if (!meta) throw new Error(`fixture ${name}: meta.json missing`)
  const states: Record<string, State> = {}
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const s = join(dir, d.name)
    const uia = readJson<UiaSnapshotResult | Record<string, never>>(join(s, 'uia.json'))
    const st: State = {}
    if (uia && 'root' in uia) st.uia = uia as UiaSnapshotResult
    const win = readJson<WindowInfo>(join(s, 'window.json'))
    if (win) st.window = win
    const bridge = readJson<Record<string, unknown>>(join(s, 'bridge.json'))
    if (bridge) st.bridge = bridge
    const ocr = readJson<unknown>(join(s, 'ocr.json'))
    if (ocr) st.ocr = ocr
    const events = readJson<ObservedEvent[]>(join(s, 'events.json'))
    if (events) st.events = events
    states[d.name] = st
  }
  return { app: meta.app, ...(meta.synthetic ? { synthetic: true } : {}), states }
}

const lessonCache = new Map<string, LessonStep[]>()

/** The parsed step of "<lessonId>#<stepId>" from the skill packs (skills/<app>/lessons). */
export function lessonStep(ref: string, skillsDir = join(REPO, 'skills')): LessonStep {
  const [lessonId, stepId] = ref.split('#')
  if (!lessonCache.has(lessonId)) {
    const file = readdirSync(skillsDir)
      .map((app) => join(skillsDir, app, 'lessons', `${lessonId}.lesson.json`))
      .find((f) => existsSync(f))
    if (!file) throw new Error(`lesson ${lessonId} not found`)
    lessonCache.set(lessonId, parseLesson(JSON.parse(readFileSync(file, 'utf8'))).steps)
  }
  const step = lessonCache.get(lessonId)!.find((s) => s.id === stepId)
  if (!step) throw new Error(`step ${ref} not found`)
  return step
}

/** The check a case scores: the lesson step's normalized expect, or the inline one. */
export function checkOf(c: Case): CheckSpec {
  if (c.step) return lessonStep(c.step).check
  return checkSchema.parse(c.expect)
}

/** Schema problems in a case, empty when valid. */
export function validateCase(
  c: Case,
  fixtureExists: (f: string) => boolean,
  load: (name: string) => Fixture = loadFixture
): string[] {
  const errs: string[] = []
  if (!c.id || !/^[a-z0-9-]+$/.test(c.id)) errs.push('id must be kebab-case')
  if (!!c.step === !!c.expect) errs.push('needs exactly one of step / expect')
  if (c.truth !== 'pass' && c.truth !== 'fail') errs.push('truth must be pass or fail')
  if (!fixtureExists(c.fixture)) errs.push(`fixture ${c.fixture} not found`)
  else {
    const fx = load(c.fixture)
    for (const s of [c.before ?? 'before', c.after ?? 'after'])
      if (!fx.states[s]) errs.push(`state ${s} missing in ${c.fixture}`)
  }
  try {
    checkOf(c)
  } catch (e) {
    errs.push(`check: ${(e as Error).message.slice(0, 120)}`)
  }
  return errs
}

export function fixtureExists(name: string, root = join(LESSONS_DIR, 'fixtures')): boolean {
  return existsSync(join(root, name, 'meta.json'))
}

// ---- The deterministic strategy: production checks over fake ports ----

/** A clock that only moves when told to; runs due timers and lets promises settle. */
class ManualClock implements Clock {
  private t = 0
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()
  now(): number {
    return this.t
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number)
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    await flush()
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      this.timers.delete(due[0])
      this.t = Math.max(this.t, due[1].at)
      due[1].fn()
      await flush()
    }
    this.t = end
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
}

/** Like teach/index findElements: interactive elements first, then every node. */
function findIn(
  uia: UiaSnapshotResult | undefined,
  q: Parameters<typeof elementHits>[1]
): ElementNode[] {
  if (!uia) return []
  const all = flattenElements(uia.root).map((f) => f.node)
  for (const nodes of [all.filter(isInteractive), all]) {
    const hits = elementHits(nodes, q)
    if (hits.length) return hits
  }
  return []
}

/** The production bridges over fixture state: the Blender bridge with a fake socket client,
 *  OBS through the production request → state mapping. */
function bridgesFor(state: () => State, app: string): Map<string, AppBridge> {
  const raw = (): Record<string, unknown> | undefined => state().bridge
  const client = {
    request: async () => {
      const s = app === 'blender' ? raw() : undefined
      return s ? { ok: true, result: s } : Promise.reject(new Error('ECONNREFUSED'))
    }
  } as unknown as BlenderClient
  const obs: AppBridge = {
    id: 'obs',
    name: 'OBS Studio',
    state: async (question) => {
      const responses = app === 'obs' ? raw() : undefined
      const req = question.request
      const map = typeof req === 'string' ? OBS_REQUESTS[req] : undefined
      const data = typeof req === 'string' ? responses?.[req] : undefined
      return map && data ? (map(data as Record<string, unknown>) as BridgeState) : null
    },
    status: async () => ({ id: 'obs', name: 'OBS Studio', state: 'absent' })
  }
  return new Map<string, AppBridge>([
    ['blender', blenderBridge(client)],
    ['obs', obs]
  ])
}

/** `manual` leaves replaced by a check that never answers (to see what decided a pass). */
function withoutManual(c: CheckSpec): CheckSpec {
  if (c.type === 'manual') return { type: 'keypress', combo: 'F24+F23' }
  if (c.type === 'anyOf' || c.type === 'allOf') return { ...c, checks: c.checks.map(withoutManual) }
  return c
}

/**
 * Runs one check like a lesson step: started in the before state (bridge baselines, first
 * polls), then the after state with its observed events, then "done" (evaluate()).
 */
export async function runCheck(
  check: CheckSpec,
  fx: Fixture,
  states: { before: string; after: string }
): Promise<{ result: CheckResult; log: string[] }> {
  let cur = fx.states[states.before]
  const after = fx.states[states.after]
  const log: string[] = []
  const clock = new ManualClock()
  const uiaSubs = new Set<{ kinds: Set<string>; cb: (e: UiaEvent) => void }>()
  const keySubs = new Set<(combo: string) => void>()
  const ports = noopPorts({
    uia: {
      find: async (q) => findIn(cur.uia, q),
      subscribe: (kinds, cb) => {
        const sub = { kinds: new Set<string>(kinds), cb }
        uiaSubs.add(sub)
        return () => uiaSubs.delete(sub)
      }
    },
    window: { activeWindow: async () => cur.window ?? null },
    keys: {
      available: () => true,
      onCombo: (cb) => {
        keySubs.add(cb)
        return () => keySubs.delete(cb)
      }
    },
    bridge: makeBridgePort(() => bridgesFor(() => cur, fx.app))
  })
  const step: LessonStep = { id: 'eval', say: 'eval', target: null, check, hints: [] }
  const handle = startCheck(check, {
    ports,
    clock,
    step,
    budget: newBudget(),
    log: (m) => log.push(m)
  })
  let settled: CheckResult | null = null
  void handle.result.then((r) => (settled = r))
  await clock.advance(0)
  cur = after
  for (const e of after.events ?? []) {
    if ('combo' in e) for (const cb of [...keySubs]) cb(e.combo)
    else for (const s of [...uiaSubs]) if (s.kinds.has(e.kind)) s.cb(e)
  }
  await clock.advance(1100)
  const result: CheckResult = settled === 'pass' ? 'pass' : await handle.evaluate()
  handle.cancel()
  await flush()
  return { result, log }
}

export const deterministic: Strategy = async (c, check, fx) => {
  const t0 = performance.now()
  const states = { before: c.before ?? 'before', after: c.after ?? 'after' }
  const { result, log } = await runCheck(check, fx, states)
  let verdict: Verdict = result
  if (result === 'pass') {
    const strict = await runCheck(withoutManual(check), fx, states)
    if (strict.result !== 'pass') verdict = 'manual'
  }
  return {
    verdict,
    latencyMs: performance.now() - t0,
    ...(log.length ? { debug: log.slice(-2).join('; ') } : {})
  }
}

/** Right for about half the cases (stable per id); tests the scorer and report. */
export const mock: Strategy = async (c) => {
  let h = 0
  for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const right = h % 2 === 0
  const verdict: Verdict = right ? c.truth : c.truth === 'pass' ? 'fail' : 'pass'
  return { verdict, latencyMs: 0 }
}

export const STRATEGIES: Record<string, Strategy> = { deterministic, mock }

/** Strategies that need frames and a model key; listed in the report, never run offline. */
export const NOT_RUN: Record<string, string> = {
  vision: 'needs before/after frames and a model key (the vision checks answer unknown offline)'
}

// ---- Scoring + report ----

export function score(c: Case, out: Output): { falsePass: boolean; falseFail: boolean } {
  return {
    falsePass: c.truth === 'fail' && out.verdict === 'pass',
    falseFail: c.truth === 'pass' && out.verdict === 'fail'
  }
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
    const check = checkOf(c)
    for (const [name, strategy] of Object.entries(strategies)) {
      const out = await strategy(c, check, fx)
      results.push({ case: c, app: fx.app, strategy: name, out, ...score(c, out) })
    }
  }
  return results
}

export interface Rates {
  cases: number
  /** False passes / truth-fail cases. */
  falsePass: number
  /** False fails / truth-pass cases. */
  falseFail: number
  /** unknown + manual (the lesson asks the user) / all cases. */
  undecided: number
  /** Truth-fail cases that pass on the user's word alone (manual). */
  manualOnFail: number
}

export function rates(results: Result[]): Rates {
  const fails = results.filter((r) => r.case.truth === 'fail')
  const passes = results.filter((r) => r.case.truth === 'pass')
  const ratio = (n: number, d: number): number => (d ? n / d : 0)
  return {
    cases: results.length,
    falsePass: ratio(fails.filter((r) => r.falsePass).length, fails.length),
    falseFail: ratio(passes.filter((r) => r.falseFail).length, passes.length),
    undecided: ratio(
      results.filter((r) => r.out.verdict === 'unknown' || r.out.verdict === 'manual').length,
      results.length
    ),
    manualOnFail: ratio(fails.filter((r) => r.out.verdict === 'manual').length, fails.length)
  }
}

const pct = (x: number): string => `${Math.round(100 * x)}%`

function table(results: Result[], key: (r: Result) => string, label: string): string[] {
  const groups = new Map<string, Result[]>()
  for (const r of results) {
    const k = `${r.strategy}\u0000${key(r)}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  return [
    `| strategy | ${label} | cases | truth pass / fail | false-pass | false-fail | undecided | pass on "done" only |`,
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...[...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, rs]) => {
        const [strategy, group] = k.split('\u0000')
        const r = rates(rs)
        const np = rs.filter((x) => x.case.truth === 'pass').length
        return `| ${strategy} | ${group} | ${rs.length} | ${np} / ${rs.length - np} | ${pct(r.falsePass)} | ${pct(r.falseFail)} | ${pct(r.undecided)} | ${pct(r.manualOnFail)} |`
      })
  ]
}

export function formatReport(results: Result[], info: { date: string; sha: string }): string {
  const wrong = results.filter((r) => r.falsePass || r.falseFail)
  const undecided = results.filter(
    (r) =>
      r.strategy === 'deterministic' && (r.out.verdict === 'unknown' || r.out.verdict === 'manual')
  )
  const onWord = results.filter(
    (r) => r.strategy === 'deterministic' && r.case.truth === 'fail' && r.out.verdict === 'manual'
  )
  const what = (c: Case): string => c.step ?? `inline ${c.expect?.type}`
  return [
    `# Lesson-check eval ${info.date} (${info.sha})`,
    '',
    'Offline run over eval/lessons/cases.jsonl: each lesson `expect` through the production',
    'check tree (teach/checks) on a before → after state pair. false-pass = said done when it',
    'was not (of the truth-fail cases); false-fail = said not yet when it was done (of the',
    'truth-pass cases); undecided = unknown or manual, so the lesson asks the user.',
    '',
    '## Summary',
    '',
    ...table(results, () => 'all', 'scope'),
    '',
    `Not run offline: ${Object.entries(NOT_RUN)
      .map(([k, v]) => `${k} (${v})`)
      .join('; ')}.`,
    '',
    '## Per app × category',
    '',
    ...table(results, (r) => `${r.app} / ${r.case.category}`, 'app / category'),
    '',
    '## Wrong verdicts',
    '',
    ...(wrong.length
      ? [
          '| strategy | case | check | truth | got | known gap |',
          '| --- | --- | --- | --- | --- | --- |',
          ...wrong.map(
            (r) =>
              `| ${r.strategy} | ${r.case.id} | ${what(r.case)} | ${r.case.truth} | ${r.out.verdict} | ${r.case.knownGap ?? ''} |`
          )
        ]
      : ['None.']),
    '',
    "## Passes on the learner's word (deterministic)",
    '',
    'Truth-fail cases that pass only through a `manual` alternative: not counted as false',
    'passes (the lesson author chose to trust "done" there), but listed so they stay visible.',
    '',
    ...(onWord.length
      ? [
          '| case | check | category |',
          '| --- | --- | --- |',
          ...onWord.map((r) => `| ${r.case.id} | ${what(r.case)} | ${r.case.category} |`)
        ]
      : ['None.']),
    '',
    '## Undecided (deterministic)',
    '',
    ...(undecided.length
      ? [
          '| case | check | truth | got |',
          '| --- | --- | --- | --- |',
          ...undecided.map(
            (r) => `| ${r.case.id} | ${what(r.case)} | ${r.case.truth} | ${r.out.verdict} |`
          )
        ]
      : ['None.'])
  ].join('\n')
}
