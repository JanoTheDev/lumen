import { describe, expect, it, vi } from 'vitest'
import {
  buildRegistry,
  findApp,
  launchEntry,
  type AppEntry,
  type AppSources
} from '../../src/main/agent-mode/apps'

const tree: Record<string, { name: string; dir: boolean }[]> = {
  'C:\\PD': [
    { name: 'Blender', dir: true },
    { name: 'Notepad++.lnk', dir: false },
    { name: 'desktop.ini', dir: false }
  ],
  'C:\\PD\\Blender': [
    { name: 'Blender 4.2.lnk', dir: false },
    { name: 'Uninstall Blender.lnk', dir: false }
  ],
  'C:\\AD': [{ name: 'Visual Studio Code.lnk', dir: false }]
}

const sources: AppSources = {
  startMenuDirs: () => ['C:\\PD', 'C:\\AD'],
  listDir: (dir) => {
    const items = tree[dir.replace(/\//g, '\\')]
    if (!items) throw new Error('ENOENT')
    return items
  },
  startApps: async () => [
    { Name: 'Calculator', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
    { Name: 'Blender 4.2', AppID: 'C:\\Program Files\\Blender\\blender.exe' }
  ]
}

describe('known-app registry', () => {
  it('collects shortcuts and packaged apps, skipping uninstallers', async () => {
    const reg = await buildRegistry(sources)
    expect(reg.map((e) => e.name).sort()).toEqual([
      'Blender 4.2',
      'Calculator',
      'Notepad++',
      'Visual Studio Code'
    ])
    expect(reg.find((e) => e.name === 'Calculator')?.launch).toEqual({
      kind: 'aumid',
      id: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'
    })
  })

  it('"open blender" finds the shortcut', async () => {
    const reg = await buildRegistry(sources)
    const { entry } = findApp('blender', reg)
    expect(entry?.launch).toMatchObject({ kind: 'lnk' })
    expect(entry?.name).toBe('Blender 4.2')
    expect(findApp('vs code', reg).entry).toBeNull()
    expect(findApp('visual studio code', reg).entry?.name).toBe('Visual Studio Code')
    expect(findApp('calculater', reg).entry?.name).toBe('Calculator')
  })

  it('paths and command lines are never apps', async () => {
    const reg = await buildRegistry(sources)
    for (const q of [
      'C:\\evil.exe',
      'evil.exe',
      '\\\\server\\share\\x',
      'https://x.test',
      'cmd /c calc',
      'blender --python x.py'
    ]) {
      expect(findApp(q, reg).entry).toBeNull()
    }
  })

  it('launches only the entry the registry found', async () => {
    const launcher = { openPath: vi.fn(async () => ''), openAumid: vi.fn(async () => {}) }
    const entry: AppEntry = {
      name: 'Blender',
      launch: { kind: 'lnk', path: 'C:\\PD\\Blender.lnk' }
    }
    await launchEntry(entry, launcher)
    expect(launcher.openPath).toHaveBeenCalledWith('C:\\PD\\Blender.lnk')
    launcher.openPath.mockResolvedValueOnce('Access denied')
    await expect(launchEntry(entry, launcher)).rejects.toThrow('Access denied')
  })
})
