import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Automation } from '@shared/automations'
import type { ProactiveRule, Routine } from '@shared/routines'
import {
  AutomationStore,
  mergeLegacy,
  parseAutomations,
  type Legacy
} from '../../src/main/routines/automation-store'
import { RoutineStore } from '../../src/main/routines/store'

const dir = mkdtempSync(join(tmpdir(), 'lumen-automations-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const routine: Routine = {
  id: 'rt_abcd1',
  name: 'News',
  prompt: 'summarize the news',
  schedule: { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] },
  preApproved: [{ tool: 'request_foreground' }],
  enabled: true,
  failures: 1,
  createdAt: 100,
  lastRunAt: 200,
  lastResult: 'failed'
}
const rule: ProactiveRule = { id: 'pr_abcd1', app: 'Resolve', say: 'Remember to back up.' }
const legacy = (enabled = true): Legacy => ({
  routines: [routine],
  proactive: { enabled, rules: [rule] }
})

describe('migration', () => {
  it('routines and proactive rules become automations without loss', () => {
    const m = mergeLegacy([], [], legacy(), 999)
    expect(m.changed).toBe(true)
    expect(m.imported.sort()).toEqual(['pr_abcd1', 'rt_abcd1'])
    expect(m.list).toEqual([
      {
        id: 'rt_abcd1',
        name: 'News',
        trigger: { kind: 'daily', at: '09:00', days: [1, 2, 3, 4, 5] },
        action: { kind: 'task', prompt: 'summarize the news' },
        preApproved: [{ tool: 'request_foreground' }],
        enabled: true,
        failures: 1,
        createdAt: 100,
        lastRunAt: 200,
        lastResult: 'failed'
      },
      {
        id: 'pr_abcd1',
        name: 'When I open Resolve',
        trigger: { kind: 'app', app: 'Resolve', on: 'open' },
        action: { kind: 'remind', say: 'Remember to back up.' },
        preApproved: [],
        enabled: true,
        failures: 0,
        createdAt: 999
      }
    ])
    // Proactive mode was off: the rule comes over switched off.
    expect(mergeLegacy([], [], legacy(false), 1).list[1].enabled).toBe(false)
  })

  it('imports each id once: a deleted automation does not come back', () => {
    const first = mergeLegacy([], [], legacy(), 1)
    const again = mergeLegacy(first.list.slice(1), first.imported, legacy(), 2)
    expect(again.changed).toBe(false)
    expect(again.list.map((a) => a.id)).toEqual(['pr_abcd1'])
  })

  it('the store writes automations.json on first load and keeps the old files', () => {
    const routinesFile = join(dir, 'routines.json')
    new RoutineStore(routinesFile).save([routine])
    const file = join(dir, 'automations.json')
    const store = new AutomationStore(file, () => ({
      routines: new RoutineStore(routinesFile).load(),
      proactive: { enabled: true, rules: [rule] }
    }))
    const list = store.load(5)
    expect(list.map((a) => a.id)).toEqual(['rt_abcd1', 'pr_abcd1'])
    expect(existsSync(routinesFile)).toBe(true)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.version).toBe(1)
    expect(saved.imported.sort()).toEqual(['pr_abcd1', 'rt_abcd1'])
    // Delete one; it stays deleted on the next start.
    store.save(list.slice(1))
    expect(new AutomationStore(file, () => legacy()).load().map((a) => a.id)).toEqual(['pr_abcd1'])
  })

  it('a broken file is kept aside and the old entries are imported again', () => {
    const sub = mkdtempSync(join(dir, 'broken-'))
    const file = join(sub, 'automations.json')
    writeFileSync(file, '{ not json', 'utf8')
    const list = new AutomationStore(file, () => legacy()).load(7)
    expect(list.map((a) => a.id)).toEqual(['rt_abcd1', 'pr_abcd1'])
    expect(readdirSync(sub).some((f) => /^automations\.invalid\.7\.json$/.test(f))).toBe(true)
  })

  it('drops malformed entries', () => {
    const good: Automation = {
      id: 'au_abcd1',
      name: 'Good',
      trigger: { kind: 'file', folder: 'C:\\D', on: 'added', pattern: '*.pdf' },
      action: { kind: 'skill', skill: 'tidy-downloads' },
      preApproved: [],
      enabled: true,
      failures: 0,
      createdAt: 1,
      wake: false,
      runs: [{ at: 1, result: 'done', via: 'event', summary: 'ok' }]
    }
    expect(
      parseAutomations({
        automations: [
          good,
          { ...good, id: 'au_bad01', trigger: { kind: 'every', minutes: 5 } },
          { ...good, id: 'bad' },
          { ...good, id: 'au_bad02', action: { kind: 'shell', cmd: 'x' } }
        ]
      })
    ).toEqual([good])
  })
})
