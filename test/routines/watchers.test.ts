import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationTrigger } from '@shared/automations'
import { RULE_COOLDOWN_MS, SETTLE_MS, type ForegroundInfo } from '../../src/main/routines/proactive'
import {
  AutomationWatchers,
  BACK_MS,
  FILE_SETTLE_MS,
  globMatch,
  POLL_MS,
  type WatcherPorts
} from '../../src/main/routines/watchers'

const MIN = 60_000
const DIR = 'C:\\Users\\me\\Downloads'

const auto = (id: string, trigger: AutomationTrigger, enabled = true): Automation => ({
  id,
  name: id,
  trigger,
  action: { kind: 'remind', say: 'Hi.' },
  preApproved: [],
  enabled,
  failures: 0,
  createdAt: 0
})

function setup(): {
  w: AutomationWatchers
  calls: string[]
  fired: string[]
  state: {
    win: ForegroundInfo
    procs: string[]
    files: Set<string>
    idle: number
    online: boolean
    granted: boolean
    folderCb: ((name: string | null) => void) | null
  }
} {
  const calls: string[] = []
  const fired: string[] = []
  const state = {
    win: { process: 'EXCEL.EXE', title: 'Book1 - Excel' } as ForegroundInfo,
    procs: ['explorer.exe', 'EXCEL.EXE'],
    files: new Set<string>(['old.pdf']),
    idle: 0,
    online: true,
    granted: true,
    folderCb: null as ((name: string | null) => void) | null
  }
  const ports: WatcherPorts = {
    focus: (on) => calls.push(`focus ${on}`),
    foreground: async () => {
      calls.push('foreground')
      return state.win
    },
    processes: async () => {
      calls.push('processes')
      return state.procs
    },
    watchFolder: (folder, cb) => {
      calls.push(`watch ${folder}`)
      state.folderCb = cb
      return () => {
        calls.push(`unwatch ${folder}`)
        state.folderCb = null
      }
    },
    listFolder: () => [...state.files],
    isFile: (p) => state.files.has(p.split('\\').pop()!),
    granted: () => state.granted,
    idleMs: () => state.idle,
    online: () => state.online,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    fire: (id, detail) => fired.push(`${id}${detail ? ` ${detail}` : ''}`)
  }
  return { w: new AutomationWatchers(ports), calls, fired, state }
}

describe('watchers: subscribe only while needed', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('nothing subscribed, polled or watched without event automations', async () => {
    const { w, calls } = setup()
    w.sync([
      auto('au_t1', { kind: 'daily', at: '09:00' }),
      auto('au_off1', { kind: 'online' }, false)
    ])
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(w.live()).toEqual({ focus: false, poll: false, folders: [] })
  })

  it('each source comes and goes with the automations that need it', () => {
    const { w, calls } = setup()
    w.sync([
      auto('au_app1', { kind: 'app', app: 'Excel', on: 'open' }),
      auto('au_file1', { kind: 'file', folder: DIR, on: 'added' }),
      auto('au_idle1', { kind: 'idle', minutes: 5, on: 'idle' })
    ])
    expect(w.live()).toEqual({ focus: true, poll: true, folders: [DIR.toLowerCase()] })
    expect(calls).toEqual(['focus true', `watch ${DIR}`])
    w.sync([auto('au_idle1', { kind: 'idle', minutes: 5, on: 'idle' })])
    expect(w.live()).toEqual({ focus: false, poll: true, folders: [] })
    w.sync([])
    expect(w.live()).toEqual({ focus: false, poll: false, folders: [] })
    expect(calls).toEqual(['focus true', `watch ${DIR}`, 'focus false', `unwatch ${DIR}`])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a folder no longer shared is not watched and shows a problem', () => {
    const { w, calls, state } = setup()
    state.granted = false
    w.sync([auto('au_file1', { kind: 'file', folder: DIR, on: 'added' })])
    expect(calls).toEqual([])
    expect(w.problem('au_file1')).toMatch(/no longer shared/)
  })
})

describe('watchers: events', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('app opens: once per change of app, with a cooldown', async () => {
    const { w, fired, state } = setup()
    w.sync([auto('au_app1', { kind: 'app', app: 'Excel', on: 'open' })])
    w.onFocusChanged()
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(fired).toEqual(['au_app1 Excel came to the front'])
    state.win = { process: 'chrome.exe', title: 'News' }
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    state.win = { process: 'EXCEL.EXE', title: 'Book1' }
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(fired).toHaveLength(1)
    state.win = { process: 'chrome.exe', title: 'News' }
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(RULE_COOLDOWN_MS)
    state.win = { process: 'EXCEL.EXE', title: 'Book1' }
    w.onFocusChanged()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(fired).toHaveLength(2)
  })

  it('app closes: seen running, then gone from the process list', async () => {
    const { w, fired, state } = setup()
    w.sync([auto('au_cls1', { kind: 'app', app: 'Excel', on: 'close' })])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fired).toEqual([])
    state.procs = ['explorer.exe']
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fired).toEqual(['au_cls1 Excel was closed'])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fired).toHaveLength(1)
  })

  it('files: a new matching file once its writes settle; temp downloads ignored', async () => {
    const { w, fired, state } = setup()
    w.sync([
      auto('au_pdf1', { kind: 'file', folder: DIR, on: 'added', pattern: '*.pdf' }),
      auto('au_chg1', { kind: 'file', folder: DIR, on: 'changed' })
    ])
    state.files.add('report.pdf.crdownload')
    state.folderCb!('report.pdf.crdownload')
    state.files.add('report.pdf')
    state.folderCb!('report.pdf')
    state.folderCb!('report.pdf')
    await vi.advanceTimersByTimeAsync(FILE_SETTLE_MS)
    const path = join(DIR, 'report.pdf')
    expect(fired).toEqual([`au_pdf1 ${path}`, `au_chg1 ${path}`])
    // A change to a known file: only the "changed" automation.
    state.folderCb!('old.pdf')
    await vi.advanceTimersByTimeAsync(FILE_SETTLE_MS)
    expect(fired.slice(2)).toEqual([`au_chg1 ${join(DIR, 'old.pdf')}`])
    // Deleted: nothing.
    state.files.delete('report.pdf')
    state.folderCb!('report.pdf')
    await vi.advanceTimersByTimeAsync(FILE_SETTLE_MS)
    expect(fired).toHaveLength(3)
  })

  it('idle and back', async () => {
    const { w, fired, state } = setup()
    w.sync([
      auto('au_idle1', { kind: 'idle', minutes: 5, on: 'idle' }),
      auto('au_back1', { kind: 'idle', minutes: 5, on: 'back' })
    ])
    state.idle = 6 * MIN
    await vi.advanceTimersByTimeAsync(POLL_MS)
    state.idle = 7 * MIN
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fired).toEqual(['au_idle1 no input for 5 minutes'])
    state.idle = BACK_MS / 2
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fired).toEqual(['au_idle1 no input for 5 minutes', 'au_back1 the user is back'])
  })

  it('back online after offline', async () => {
    const { w, fired, state } = setup()
    w.sync([auto('au_net1', { kind: 'online' })])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fired).toEqual([])
    state.online = false
    await vi.advanceTimersByTimeAsync(POLL_MS)
    state.online = true
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fired).toEqual(['au_net1 the network is back'])
  })

  it('glob patterns', () => {
    expect(globMatch('*.pdf', 'Report.PDF')).toBe(true)
    expect(globMatch('*.pdf', 'report.pdf.txt')).toBe(false)
    expect(globMatch(undefined, 'x')).toBe(true)
    expect(globMatch('inv?.csv', 'inv1.csv')).toBe(true)
  })
})
