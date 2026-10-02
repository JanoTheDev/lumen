// A save step without the OK button's Invoked event (Qt may never raise it): `absent` vetoes
// on a seen Cancel, and `since: "lesson"` keeps a value applied in an earlier step changed.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { realClock } from '../../src/main/a11y/timings'
import { makeBridgePort } from '../../src/main/teach/bridges/port'
import type { AppBridge } from '../../src/main/teach/bridges/types'
import { newBudget, startCheck, type CheckContext } from '../../src/main/teach/checks'
import { checkSchema, type CheckSpec, type LessonStep } from '../../src/main/teach/lesson'
import { noopPorts, type Ports, type UiaEvent } from '../../src/main/teach/ports'
import { loadSchemas, validatePackFolder } from '../../skills/schema/validate.mjs'

const STEP: LessonStep = {
  id: 's',
  say: 'Do it.',
  target: null,
  check: { type: 'manual' },
  hints: []
}

function ctx(ports: Partial<Ports>, lessonStart?: Map<string, unknown>): CheckContext {
  return {
    ports: noopPorts(ports),
    clock: realClock,
    step: STEP,
    budget: newBudget(),
    log: () => {},
    ...(lessonStart ? { lessonStart } : {})
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

async function peek(p: Promise<string>): Promise<string> {
  let v = 'pending'
  void p.then((r) => (v = r))
  await flush()
  return v
}

function uiaEvents(): { port: Ports['uia']; emit(e: UiaEvent): void } {
  const subs = new Set<(e: UiaEvent) => void>()
  return {
    emit: (e) => subs.forEach((s) => s(e)),
    port: {
      find: async () => [],
      subscribe: (_kinds, cb) => {
        subs.add(cb)
        return () => subs.delete(cb)
      }
    }
  }
}

const cancelAbsent: CheckSpec = {
  type: 'uia-event',
  event: 'invoked',
  absent: true,
  match: { name: 'Cancel', role: 'Button' }
}
const cancelEvent: UiaEvent = { kind: 'invoked', element: { name: 'Cancel', role: 'button' } }

describe('absent', () => {
  it('is valid only on an invoked check', () => {
    expect(checkSchema.safeParse(cancelAbsent).success).toBe(true)
    expect(checkSchema.safeParse({ ...cancelAbsent, event: 'value' }).success).toBe(false)
  })

  it('holds until the event is seen, never passes live on its own', async () => {
    const uia = uiaEvents()
    const h = startCheck(cancelAbsent, ctx({ uia: uia.port }))
    expect(await h.evaluate()).toBe('pass')
    expect(await peek(h.result)).toBe('pending')
    uia.emit({ kind: 'invoked', element: { name: 'OK', role: 'button' } })
    expect(await h.evaluate()).toBe('pass')
    uia.emit(cancelEvent)
    expect(await h.evaluate()).toBe('fail')
    h.cancel()
  })

  it('an allOf passes live without it, and a seen Cancel holds the pass back', async () => {
    const closed: CheckSpec = { type: 'allOf', checks: [{ type: 'manual' }, cancelAbsent] }
    // manual never settles live, so use a keypress as the live signal.
    const spec: CheckSpec = {
      type: 'allOf',
      checks: [{ type: 'keypress', combo: 'Ctrl+S' }, cancelAbsent]
    }
    let combo: ((c: string) => void) | null = null
    const keys: Ports['keys'] = {
      available: () => true,
      onCombo: (cb) => {
        combo = cb
        return () => (combo = null)
      }
    }
    const uia = uiaEvents()
    const ok = startCheck(spec, ctx({ uia: uia.port, keys }))
    combo!('Ctrl+S')
    expect(await ok.result).toBe('pass')
    ok.cancel()

    const vetoed = startCheck(spec, ctx({ uia: uia.port, keys }))
    uia.emit(cancelEvent)
    combo!('Ctrl+S')
    expect(await peek(vetoed.result)).toBe('pending')
    expect(await vetoed.evaluate()).toBe('fail')
    vetoed.cancel()

    const done = startCheck(closed, ctx({ uia: uia.port }))
    expect(await done.evaluate()).toBe('pass')
    done.cancel()
  })
})

describe('bridge since lesson', () => {
  let dir = 'C:\\Users\\demo\\Videos'
  const obs: AppBridge = {
    id: 'obs',
    name: 'OBS Studio',
    state: async () => ({ recordDirectory: dir }),
    status: async () => ({ id: 'obs', name: 'OBS Studio', state: 'connected' })
  }
  const port = makeBridgePort(() => new Map([['obs', obs]]))
  const changed = { request: 'GetRecordDirectory', recordDirectoryChanged: true }

  it('compares with the lesson’s first answer, not the step’s', async () => {
    dir = 'C:\\Users\\demo\\Videos'
    const lesson = new Map<string, unknown>()
    // An earlier step asked first (the folder before the learner browsed).
    await port.query('obs', changed, new AbortController().signal, { lessonStart: lesson })
    dir = 'D:\\Rec' // picked and applied in that step
    const stepSignal = new AbortController().signal
    expect(await port.query('obs', changed, stepSignal, { lessonStart: lesson })).toBe('fail')
    const since = { lessonStart: lesson, since: 'lesson' as const }
    expect(await port.query('obs', changed, new AbortController().signal, since)).toBe('pass')
    // Without lesson answers it falls back to the step's first answer.
    expect(await port.query('obs', changed, stepSignal, { since: 'lesson' })).toBe('fail')
  })

  it('the bridge check passes its lesson map and `since` to the port', async () => {
    dir = 'C:\\Users\\demo\\Videos'
    const lesson = new Map<string, unknown>()
    await port.query('obs', changed, undefined, { lessonStart: lesson })
    dir = 'D:\\Rec'
    const spec: CheckSpec = { type: 'bridge', app: 'obs', since: 'lesson', expect: changed }
    const h = startCheck(spec, ctx({ bridge: port }, lesson))
    expect(await h.evaluate()).toBe('pass')
    h.cancel()
    const stepOnly = startCheck({ ...spec, since: undefined }, ctx({ bridge: port }, lesson))
    expect(await stepOnly.evaluate()).toBe('fail')
    stepOnly.cancel()
  })
})

describe('validate:skills', () => {
  let tmp = ''
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }))

  it('accepts the OBS pack and flags an absent check outside an allOf', () => {
    const schemas = loadSchemas(join(__dirname, '..', '..', 'skills', 'schema'))
    tmp = mkdtempSync(join(tmpdir(), 'lumen-absent-'))
    const pack = join(tmp, 'obs')
    cpSync(join(__dirname, '..', '..', 'skills', 'obs'), pack, { recursive: true })
    expect(validatePackFolder(pack, schemas)).toEqual([])
    const file = join(pack, 'lessons', 'obs-basics-02-add-microphone.lesson.json')
    const lesson = JSON.parse(readFileSync(file, 'utf8'))
    const save = lesson.steps.find((s: { id: string }) => s.id === 'save-settings')
    save.expect.check.checks.push(cancelAbsent)
    writeFileSync(file, JSON.stringify(lesson, null, 2))
    const problems = validatePackFolder(pack, schemas).map((p) => p.message)
    expect(problems.some((m) => m.includes('must sit directly in an allOf'))).toBe(true)
  })
})
