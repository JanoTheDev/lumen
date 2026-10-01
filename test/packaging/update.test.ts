import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import {
  CHECK_EVERY_MS,
  checkDue,
  compareVersions,
  isNewer,
  LATEST_FEED_URL,
  parseFeedVersion,
  updateMode
} from '../../src/main/update/policy'
import { UpdateService, type UpdateDeps, type UpdaterLike } from '../../src/main/update/service'
import { updateLine } from '../../src/renderer/src/panel/settings/sections/update-line'

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  autoRunAppAfterInstall = true
  logger: UpdaterLike['logger'] = null
  quitAndInstall = vi.fn()
  downloadUpdate = vi.fn(async () => [])
  checkForUpdates = vi.fn(async (): Promise<unknown> => null)
}

function service(over: Partial<UpdateDeps> = {}): {
  s: UpdateService
  u: FakeUpdater
  deps: UpdateDeps
} {
  const u = new FakeUpdater()
  const deps: UpdateDeps = {
    mode: 'installer',
    currentVersion: '0.1.0',
    enabled: () => true,
    isOnline: () => true,
    loadUpdater: vi.fn(async () => u),
    fetchText: vi.fn(async () => 'version: 0.2.0\n'),
    log: () => {},
    now: () => 1000,
    ...over
  }
  return { s: new UpdateService(deps), u, deps }
}

describe('update policy', () => {
  it('picks the mode from the build', () => {
    expect(updateMode(false, false)).toBe('dev')
    expect(updateMode(false, true)).toBe('dev')
    expect(updateMode(true, true)).toBe('portable')
    expect(updateMode(true, false)).toBe('installer')
  })

  it('orders versions like semver', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(isNewer('0.1.1', '0.1.0')).toBe(true)
    expect(isNewer('v0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0-beta.1')).toBe(true)
    expect(isNewer('0.1.0-beta.2', '0.1.0-beta.10')).toBe(false)
    expect(isNewer('0.1.0-beta.10', '0.1.0-beta.2')).toBe(true)
    expect(isNewer('0.1.0-alpha', '0.1.0')).toBe(false)
    expect(compareVersions('nope', '0.1.0')).toBeNull()
  })

  it('reads the version from latest.yml', () => {
    const yml =
      "version: 0.2.0\nfiles:\n  - url: Lumen-Setup-0.2.0.exe\nreleaseDate: '2026-10-01'\n"
    expect(parseFeedVersion(yml)).toBe('0.2.0')
    expect(parseFeedVersion("version: '1.0.0-beta.1'\n")).toBe('1.0.0-beta.1')
    expect(parseFeedVersion('files: []')).toBeNull()
  })

  it('checks at most once a day and only when enabled', () => {
    expect(checkDue(true, undefined, 0)).toBe(true)
    expect(checkDue(false, undefined, 0)).toBe(false)
    expect(checkDue(true, 0, CHECK_EVERY_MS - 1)).toBe(false)
    expect(checkDue(true, 0, CHECK_EVERY_MS)).toBe(true)
  })

  it('reads the feed over https from GitHub releases', () => {
    expect(LATEST_FEED_URL.startsWith('https://github.com/JanoTheDev/lumen/releases/')).toBe(true)
  })
})

describe('update service', () => {
  it('never checks in dev builds', async () => {
    const { s, deps } = service({ mode: 'dev' })
    expect((await s.check()).state).toBe('idle')
    expect(deps.loadUpdater).not.toHaveBeenCalled()
    expect(deps.fetchText).not.toHaveBeenCalled()
  })

  it('skips the network when offline; only a manual check says so', async () => {
    const { s, deps } = service({ isOnline: () => false })
    expect((await s.check(false)).state).toBe('idle')
    expect((await s.check(true)).error).toMatch(/offline/)
    expect(deps.loadUpdater).not.toHaveBeenCalled()
  })

  it('downloads in the background and waits for quit or a click', async () => {
    const { s, u } = service()
    u.checkForUpdates.mockImplementation(async () => {
      u.emit('update-available', { version: '0.2.0' })
      return { downloadPromise: Promise.reject(new Error('handled by the error event')) }
    })
    await s.check(false)
    expect(u.autoRunAppAfterInstall).toBe(false)
    expect(u.autoInstallOnAppQuit).toBe(true)
    expect(s.status()).toMatchObject({ state: 'downloading', version: '0.2.0' })
    u.emit('download-progress', { percent: 41.6 })
    expect(s.status().percent).toBe(42)
    u.emit('update-downloaded', { version: '0.2.0' })
    expect(s.status().state).toBe('ready')
    expect(u.quitAndInstall).not.toHaveBeenCalled()
    expect(s.install()).toEqual({ ok: true })
    expect(u.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('follows the config switch', async () => {
    let on = true
    const { s, u } = service({ enabled: () => on })
    await s.check()
    on = false
    s.applyEnabled()
    expect(u.autoDownload).toBe(false)
    expect(u.autoInstallOnAppQuit).toBe(false)
  })

  it('reports up to date', async () => {
    const { s, u } = service()
    u.checkForUpdates.mockImplementation(async () => {
      u.emit('update-not-available', { version: '0.1.0' })
      return null
    })
    expect(await s.check()).toMatchObject({ state: 'up-to-date', checkedAt: 1000 })
    expect(s.install()).toEqual({ ok: false })
  })

  it('fails quietly on automatic checks, visibly on manual ones', async () => {
    const { s, u } = service()
    u.checkForUpdates.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'))
    expect((await s.check(false)).state).toBe('idle')
    expect((await s.check(true)).state).toBe('error')
  })

  it('portable: reads latest.yml and offers a link, never the updater', async () => {
    const { s, deps } = service({ mode: 'portable' })
    const st = await s.check()
    expect(deps.fetchText).toHaveBeenCalledWith(LATEST_FEED_URL)
    expect(deps.loadUpdater).not.toHaveBeenCalled()
    expect(st).toMatchObject({
      state: 'available',
      version: '0.2.0',
      url: 'https://github.com/JanoTheDev/lumen/releases/tag/v0.2.0'
    })
    expect(s.install()).toEqual({ ok: false })
  })

  it('portable: same version is up to date', async () => {
    const { s } = service({ mode: 'portable', fetchText: async () => 'version: 0.1.0\n' })
    expect((await s.check()).state).toBe('up-to-date')
  })

  it('daily timer checks only when enabled', async () => {
    vi.useFakeTimers()
    try {
      let on = false
      const { s, deps } = service({ mode: 'portable', enabled: () => on, now: () => Date.now() })
      s.start()
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
      expect(deps.fetchText).not.toHaveBeenCalled()
      on = true
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(deps.fetchText).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000)
      expect(deps.fetchText).toHaveBeenCalledTimes(1)
      s.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('update line', () => {
  it('describes each state', () => {
    expect(updateLine(null, true)).toBe('')
    expect(updateLine({ mode: 'dev', state: 'idle' }, true)).toMatch(/development/)
    expect(updateLine({ mode: 'installer', state: 'idle' }, false)).toMatch(/off/)
    expect(updateLine({ mode: 'installer', state: 'ready', version: '0.2.0' }, true)).toMatch(
      /installs when you quit/
    )
    expect(
      updateLine({ mode: 'installer', state: 'downloading', version: '0.2.0', percent: 5 }, true)
    ).toBe('Downloading version 0.2.0 (5%)…')
    expect(updateLine({ mode: 'portable', state: 'available', version: '0.2.0' }, true)).toBe(
      'Version 0.2.0 is available.'
    )
  })
})
