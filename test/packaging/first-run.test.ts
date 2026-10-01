import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import {
  CHECK_IDS,
  fixCheck,
  listChecks,
  runCheck,
  SETTINGS_URI,
  type CheckProbes
} from '../../src/main/first-run/checks'
import { applyAutostart, startedHidden } from '../../src/main/first-run/autostart'
import { isPortable } from '../../src/main/first-run/portable'

function probes(over: Partial<CheckProbes> = {}): CheckProbes {
  return {
    keyProviders: () => ['anthropic'],
    localMode: () => false,
    micAccess: () => 'granted',
    agent: () => ({ running: true, version: '0.1.0', error: null }),
    hotkey: () => 'Ctrl+Shift+Space',
    waitForHotkey: async () => true,
    ocr: async () => {},
    wakeEnabled: () => true,
    wakeUnavailable: () => null,
    wakeModelInstalled: () => true,
    wakeModelSizeMb: () => 18,
    installWakeModel: async () => {},
    restartAgent: async () => {},
    elevated: async () => false,
    openUri: async () => {},
    ...over
  }
}

const byId = (p: CheckProbes, id: string): ReturnType<typeof listChecks>[number] =>
  listChecks(p).find((c) => c.id === id)!

describe('first-run checks', () => {
  it('lists every check; interactive ones stay pending', () => {
    const list = listChecks(probes())
    expect(list.map((c) => c.id)).toEqual([...CHECK_IDS])
    expect(list.filter((c) => c.status === 'pending').map((c) => c.id)).toEqual([
      'hotkey',
      'ocr',
      'elevation'
    ])
    expect(list.filter((c) => c.status !== 'pending').every((c) => c.status === 'ok')).toBe(true)
  })

  it('keys: fails without a key unless local mode', () => {
    expect(byId(probes({ keyProviders: () => [] }), 'keys').status).toBe('fail')
    expect(byId(probes({ keyProviders: () => [], localMode: () => true }), 'keys').status).toBe(
      'ok'
    )
  })

  it('microphone: denied offers the privacy page', async () => {
    const opened: string[] = []
    const p = probes({ micAccess: () => 'denied', openUri: async (u) => void opened.push(u) })
    const c = byId(p, 'microphone')
    expect(c.status).toBe('fail')
    expect(c.fixAction).toBeTruthy()
    expect(await fixCheck('microphone', p)).toEqual({ ok: true })
    expect(opened).toEqual([SETTINGS_URI.microphone])
  })

  it('agent: down fails with a restart and says why', async () => {
    const restart = vi.fn(async () => {})
    const down = probes({ agent: () => null, restartAgent: restart })
    expect(byId(down, 'agent').status).toBe('fail')
    await fixCheck('agent', down)
    expect(restart).toHaveBeenCalled()
    const missing = probes({
      agent: () => ({ running: false, version: null, error: 'native agent not found' })
    })
    expect(byId(missing, 'agent')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('native agent not found')
    })
  })

  it('hotkey: waits for a press', async () => {
    const wait = vi.fn(async () => false)
    const c = await runCheck('hotkey', probes({ waitForHotkey: wait }))
    expect(wait).toHaveBeenCalledWith(20_000)
    expect(c.status).toBe('fail')
    expect((await runCheck('hotkey', probes())).status).toBe('ok')
  })

  it('ocr: a missing language pack points at language settings', async () => {
    const noLang = probes({
      ocr: async () => {
        throw Object.assign(new Error('no ocr language'), { code: 'E_UNSUPPORTED' })
      }
    })
    const c = await runCheck('ocr', noLang)
    expect(c.status).toBe('fail')
    expect(c.fixAction).toBeTruthy()
    const other = probes({
      ocr: async () => {
        throw new Error('timeout')
      }
    })
    expect((await runCheck('ocr', other)).status).toBe('warn')
    expect((await runCheck('ocr', probes())).status).toBe('ok')
  })

  it('wake model: off is fine, missing offers the download', async () => {
    expect(
      byId(probes({ wakeEnabled: () => false, wakeModelInstalled: () => false }), 'wake-model')
        .status
    ).toBe('ok')
    const install = vi.fn(async () => {})
    const p = probes({ wakeModelInstalled: () => false, installWakeModel: install })
    expect(byId(p, 'wake-model')).toMatchObject({ status: 'warn', fixAction: 'Download' })
    expect(await fixCheck('wake-model', p)).toEqual({ ok: true })
    expect(install).toHaveBeenCalled()
    const failing = probes({
      installWakeModel: async () => {
        throw new Error('offline')
      }
    })
    expect(await fixCheck('wake-model', failing)).toEqual({ ok: false, error: 'offline' })
  })

  it('wake model: an engine that cannot load warns without a download', () => {
    const p = probes({ wakeUnavailable: () => 'The engine could not load.' })
    const c = byId(p, 'wake-model')
    expect(c).toMatchObject({ status: 'warn', message: expect.stringContaining('could not load') })
    expect(c.fixAction).toBeUndefined()
  })

  it('elevation: warns when running as admin', async () => {
    expect((await runCheck('elevation', probes({ elevated: async () => true }))).status).toBe(
      'warn'
    )
    expect((await runCheck('elevation', probes())).status).toBe('ok')
    expect((await fixCheck('elevation', probes())).ok).toBe(false)
  })
})

describe('start at login', () => {
  const api = (): {
    setLoginItemSettings: ReturnType<typeof vi.fn>
    getLoginItemSettings: ReturnType<typeof vi.fn>
  } => ({
    setLoginItemSettings: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false }) as Electron.LoginItemSettings)
  })

  it('registers the installed exe with --hidden under the name Lumen', () => {
    const a = api()
    expect(applyAutostart(true, a, true)).toBe(true)
    expect(a.setLoginItemSettings).toHaveBeenCalledWith(
      expect.objectContaining({ openAtLogin: true, args: ['--hidden'], name: 'Lumen' })
    )
  })

  it('does nothing when already in that state or unsupported (dev, portable)', () => {
    const a = api()
    applyAutostart(false, a, true)
    expect(a.setLoginItemSettings).not.toHaveBeenCalled()
    expect(applyAutostart(true, a, false)).toBe(false)
    expect(a.getLoginItemSettings).toHaveBeenCalledTimes(1)
  })

  it('detects the hidden start and the portable exe', () => {
    expect(startedHidden(['Lumen.exe', '--hidden'])).toBe(true)
    expect(startedHidden(['Lumen.exe'])).toBe(false)
    expect(isPortable({ PORTABLE_EXECUTABLE_DIR: 'E:\\' })).toBe(true)
    expect(isPortable({})).toBe(false)
  })
})
