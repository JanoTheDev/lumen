// Task Scheduler command building is pure; WakeTasks runs against a fake exec. schtasks.exe is
// never started by these tests.
import { describe, expect, it } from 'vitest'
import type { Automation } from '@shared/automations'
import {
  automationIdFromArgv,
  createArgs,
  deleteArgs,
  localStamp,
  parseLumenTasks,
  queryArgs,
  taskXml,
  triggerXml,
  WakeTasks,
  type WakePorts
} from '../../src/main/routines/schtasks'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi).getTime()
const NOW = at(2026, 10, 1, 8, 0)
const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\lumen\\Lumen.exe'

const auto = (p: Partial<Automation> & Pick<Automation, 'id' | 'trigger'>): Automation => ({
  name: 'Inbox & news',
  action: { kind: 'task', prompt: 'x' },
  preApproved: [],
  enabled: true,
  failures: 0,
  createdAt: 0,
  wake: true,
  ...p
})

describe('schtasks commands', () => {
  it('builds create / delete / query args (no shell, per user, no admin flags)', () => {
    expect(createArgs('au_abc123', 'C:\\t\\x.xml')).toEqual([
      '/Create',
      '/F',
      '/TN',
      '\\Lumen\\au_abc123',
      '/XML',
      'C:\\t\\x.xml'
    ])
    expect(deleteArgs('au_abc123')).toEqual(['/Delete', '/F', '/TN', '\\Lumen\\au_abc123'])
    expect(queryArgs()).toEqual(['/Query', '/FO', 'CSV', '/NH'])
    expect(createArgs('au_abc123', 'x').join(' ')).not.toMatch(/\/RU|\/RL|HIGHEST|SYSTEM/i)
  })

  it('reads --run-automation from argv (validated)', () => {
    expect(automationIdFromArgv(['Lumen.exe', '--hidden', '--run-automation', 'au_abc123'])).toBe(
      'au_abc123'
    )
    expect(automationIdFromArgv(['Lumen.exe', '--run-automation=rt_abcd1'])).toBe('rt_abcd1')
    expect(automationIdFromArgv(['Lumen.exe', '--run-automation', '../../x'])).toBeNull()
    expect(automationIdFromArgv(['Lumen.exe'])).toBeNull()
  })

  it('parses its own tasks from the query output only', () => {
    const csv = [
      '"\\Lumen\\au_abc123","10/2/2026 9:00:00 AM","Ready"',
      '"\\Lumen\\rt_abcd1","N/A","Ready"',
      '"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","N/A","Ready"',
      '"\\Lumen\\notours","N/A","Ready"'
    ].join('\r\n')
    expect(parseLumenTasks(csv)).toEqual(['au_abc123', 'rt_abcd1'])
  })
})

describe('task XML', () => {
  it('daily, weekdays, monthly, once, every (with and without a window)', () => {
    expect(triggerXml({ kind: 'daily', at: '09:00' }, NOW)).toContain(
      '<StartBoundary>2026-10-01T09:00:00</StartBoundary>'
    )
    expect(triggerXml({ kind: 'daily', at: '09:00' }, NOW)).toContain(
      '<DaysInterval>1</DaysInterval>'
    )
    const wk = triggerXml({ kind: 'daily', at: '07:30', days: [1, 2, 3, 4, 5] }, NOW)
    expect(wk).toContain('<ScheduleByWeek>')
    expect(wk).toContain('<Monday /><Tuesday /><Wednesday /><Thursday /><Friday />')
    expect(wk).not.toContain('<Saturday />')
    const mo = triggerXml({ kind: 'monthly', day: 1, at: '09:00' }, NOW)
    expect(mo).toContain('<DaysOfMonth><Day>1</Day></DaysOfMonth>')
    expect(mo).toContain('<December />')
    expect(triggerXml({ kind: 'monthly', day: 31, at: '09:00' }, NOW)).toContain('<Day>Last</Day>')
    // Day 29 / 30: Task Scheduler skips February, so February's last day gets its own trigger.
    for (const day of [29, 30]) {
      const x = triggerXml({ kind: 'monthly', day, at: '09:00' }, NOW)
      expect(x.match(/<CalendarTrigger>/g)).toHaveLength(2)
      expect(x).toContain(`<Day>${day}</Day>`)
      expect(x).toContain('<DaysOfMonth><Day>Last</Day></DaysOfMonth><Months><February /></Months>')
    }
    expect(mo.match(/<CalendarTrigger>/g)).toHaveLength(1)
    expect(triggerXml({ kind: 'once', at: at(2026, 10, 2, 8) }, NOW)).toBe(
      '<TimeTrigger><StartBoundary>2026-10-02T08:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>'
    )
    const win = triggerXml({ kind: 'every', minutes: 60, from: '09:00', to: '17:00' }, NOW)
    expect(win).toContain('<Interval>PT60M</Interval><Duration>PT481M</Duration>')
    expect(win).toContain('<StartBoundary>2026-10-01T09:00:00</StartBoundary>')
    const all = triggerXml({ kind: 'every', minutes: 30 }, NOW)
    expect(all).toContain('<Interval>PT30M</Interval><Duration>P1D</Duration>')
  })

  it('the task: escaped name, exe, wake args, parallel instances, no time limit', () => {
    const xml = taskXml(
      auto({ id: 'au_abc123', trigger: { kind: 'daily', at: '09:00' } }),
      EXE,
      NOW
    )!
    expect(xml).toContain('Lumen automation: Inbox &amp; news')
    expect(xml).toContain(`<Command>${EXE}</Command>`)
    expect(xml).toContain('<Arguments>--hidden --run-automation au_abc123</Arguments>')
    expect(xml).toContain('<MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>')
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(taskXml(auto({ id: 'au_abc123', trigger: { kind: 'startup' } }), EXE, NOW)).toBeNull()
    expect(localStamp(at(2026, 1, 5, 7, 3))).toBe('2026-01-05T07:03:00')
  })
})

describe('WakeTasks (fake exec)', () => {
  function setup(opts: { supported?: boolean; fail?: RegExp; existing?: string[] } = {}): {
    w: WakeTasks
    calls: string[][]
    files: string[]
  } {
    const calls: string[][] = []
    const files: string[] = []
    const ports: WakePorts = {
      supported: () => opts.supported ?? true,
      exe: () => EXE,
      exec: async (args) => {
        calls.push(args)
        if (opts.fail && opts.fail.test(args.join(' '))) throw new Error('access denied')
        if (args[0] === '/Query')
          return (opts.existing ?? []).map((id) => `"\\Lumen\\${id}","N/A","Ready"`).join('\n')
        return 'SUCCESS'
      },
      writeXml: (id) => {
        files.push(id)
        return `C:\\tmp\\lumen-wake-${id}.xml`
      },
      removeXml: (p) => files.push(`rm ${p}`),
      now: () => NOW,
      log: () => {}
    }
    return { w: new WakeTasks(ports), calls, files }
  }

  it('dev / portable: never runs schtasks', async () => {
    const { w, calls } = setup({ supported: false })
    await w.reconcile([auto({ id: 'au_abc123', trigger: { kind: 'daily', at: '09:00' } })])
    await w.sync([auto({ id: 'au_abc123', trigger: { kind: 'daily', at: '09:00' } })])
    expect(calls).toEqual([])
    expect(w.active('au_abc123')).toBe(false)
  })

  it('reconcile drops stale tasks and registers wanted ones', async () => {
    const { w, calls, files } = setup({ existing: ['au_gone01', 'au_abc123'] })
    await w.reconcile([
      auto({ id: 'au_abc123', trigger: { kind: 'daily', at: '09:00' } }),
      auto({ id: 'au_nowake', trigger: { kind: 'daily', at: '09:00' }, wake: false }),
      auto({ id: 'au_event1', trigger: { kind: 'startup' } })
    ])
    expect(calls.map((c) => `${c[0]} ${c[3] ?? ''}`.trim())).toEqual([
      '/Query /NH',
      '/Delete \\Lumen\\au_gone01',
      '/Create \\Lumen\\au_abc123'
    ])
    expect(files).toEqual(['au_abc123', 'rm C:\\tmp\\lumen-wake-au_abc123.xml'])
    expect(w.active('au_abc123')).toBe(true)
  })

  it('sync: re-registers on change, removes when off or deleted, reports a refusal', async () => {
    const { w, calls } = setup()
    const a = auto({ id: 'au_abc123', trigger: { kind: 'daily', at: '09:00' } })
    await w.sync([a])
    await w.sync([a])
    expect(calls).toHaveLength(1)
    await w.sync([{ ...a, trigger: { kind: 'daily', at: '10:00' } }])
    expect(calls).toHaveLength(2)
    await w.sync([{ ...a, enabled: false }])
    expect(calls[2]).toEqual(deleteArgs('au_abc123'))
    expect(w.active('au_abc123')).toBe(false)
    await w.sync([a])
    await w.sync([], ['au_abc123'])
    expect(calls.at(-1)).toEqual(deleteArgs('au_abc123'))

    const bad = setup({ fail: /Create/ })
    await bad.w.sync([a])
    expect(bad.w.active('au_abc123')).toBe(false)
    expect(bad.w.error('au_abc123')).toMatch(/only while Lumen is open/)
  })
})
