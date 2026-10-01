import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import {
  explorerFolders,
  fileAt,
  matchShownName,
  mentionsPointedFile,
  surfaceOf,
  type ElementAtResult,
  type PointedDeps
} from '../../src/main/files/pointed'
import { sharePointedFile } from '../../src/main/files/share'

// element_at output for a file row in File Explorer's Details view (Windows 11): the hit is
// the name cell's edit, its row is the list item.
const EXPLORER_ROW: ElementAtResult = {
  element: { role: 'edit', name: 'Name' },
  item: { role: 'listitem', name: 'Budget 2026' },
  window: {
    hwnd: 4242,
    className: 'CabinetWClass',
    process: 'explorer.exe',
    title: 'Reports - File Explorer'
  }
}
const DESKTOP_ICON: ElementAtResult = {
  element: { role: 'listitem', name: 'notes' },
  item: { role: 'listitem', name: 'notes' },
  window: { hwnd: 10, className: 'Progman', process: 'explorer.exe', title: 'Program Manager' }
}

function deps(at: ElementAtResult | null, dirs: Record<string, string[]>): PointedDeps {
  return {
    elementAt: async () => at,
    shellWindows: async () => [
      { hwnd: 4242, path: 'C:\\Users\\ana\\Documents', name: 'Documents' },
      { hwnd: 4242, path: 'C:\\Users\\ana\\Documents\\Reports', name: 'Reports' },
      { hwnd: 77, path: 'D:\\Other', name: 'Other' },
      { hwnd: 4242, path: '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}', name: 'This PC' }
    ],
    desktopFolders: () => ['C:\\Users\\ana\\Desktop', 'C:\\Users\\Public\\Desktop'],
    list: async (dir) => dirs[dir] ?? [],
    join
  }
}

describe('surfaceOf', () => {
  it('knows Explorer windows and the desktop', () => {
    expect(surfaceOf(EXPLORER_ROW.window)).toBe('explorer')
    expect(surfaceOf(DESKTOP_ICON.window)).toBe('desktop')
    expect(surfaceOf({ hwnd: 1, className: 'WorkerW', process: 'explorer.exe', title: '' })).toBe(
      'desktop'
    )
    expect(
      surfaceOf({ hwnd: 1, className: 'Chrome_WidgetWin_1', process: 'chrome.exe', title: '' })
    ).toBeNull()
    expect(surfaceOf(undefined)).toBeNull()
  })
})

describe('explorerFolders', () => {
  it('picks the active tab by the window title', async () => {
    const wins = await deps(null, {}).shellWindows()
    expect(explorerFolders(wins, 4242, 'Reports - File Explorer')).toEqual([
      'C:\\Users\\ana\\Documents\\Reports'
    ])
    expect(explorerFolders(wins, 77, 'Other - File Explorer')).toEqual(['D:\\Other'])
    expect(explorerFolders(wins, 4242, 'Something else')).toHaveLength(2)
  })
})

describe('matchShownName', () => {
  it('finds the file behind a name shown without its extension', () => {
    expect(matchShownName('Budget 2026', ['Budget 2026.xlsx', 'Budget 2026 old.xlsx'])).toEqual([
      'Budget 2026.xlsx'
    ])
    expect(matchShownName('a.csv', ['a.csv', 'a.csv.txt'])).toEqual(['a.csv'])
    expect(matchShownName('report', ['report.lnk', 'report.pdf'])).toEqual([
      'report.pdf',
      'report.lnk'
    ])
    expect(matchShownName('', ['x'])).toEqual([])
  })
})

describe('fileAt', () => {
  it('resolves a row in File Explorer to its path', async () => {
    const r = await fileAt(
      { x: 1, y: 1 },
      deps(EXPLORER_ROW, { 'C:\\Users\\ana\\Documents\\Reports': ['Budget 2026.xlsx', 'b.txt'] })
    )
    expect(r).toEqual({ ok: true, path: 'C:\\Users\\ana\\Documents\\Reports\\Budget 2026.xlsx' })
  })

  it('resolves a desktop icon from the user or the public desktop', async () => {
    const r = await fileAt(
      { x: 1, y: 1 },
      deps(DESKTOP_ICON, { 'C:\\Users\\Public\\Desktop': ['notes.md'] })
    )
    expect(r).toEqual({ ok: true, path: 'C:\\Users\\Public\\Desktop\\notes.md' })
  })

  it('asks when two readable files share the shown name', async () => {
    const r = await fileAt(
      { x: 1, y: 1 },
      deps(EXPLORER_ROW, {
        'C:\\Users\\ana\\Documents\\Reports': ['Budget 2026.xlsx', 'Budget 2026.csv']
      })
    )
    expect(r?.ok).toBe(false)
  })

  it('is null off files and an error for folders', async () => {
    expect(await fileAt({ x: 1, y: 1 }, deps(null, {}))).toBeNull()
    expect(await fileAt({ x: 1, y: 1 }, deps({ ...EXPLORER_ROW, item: null }, {}))).toBeNull()
    const folder = await fileAt({ x: 1, y: 1 }, deps(EXPLORER_ROW, {}))
    expect(folder).toMatchObject({ ok: false })
  })
})

describe('sharePointedFile', () => {
  it('shares the file under the pointer for "this file" requests only', async () => {
    const register = vi.fn(async (path: string) => ({
      ok: true as const,
      file: { id: 'f_abcd1', name: 'x', size: 1, kind: 'sheet' as const, path, fresh: true }
    }))
    const point = vi.fn(() => ({ x: 5, y: 6 }))
    const d = {
      point,
      pointed: async () =>
        deps(EXPLORER_ROW, { 'C:\\Users\\ana\\Documents\\Reports': ['Budget 2026.xlsx'] }),
      register
    }
    expect(await sharePointedFile('what time is it', d)).toBeNull()
    expect(register).not.toHaveBeenCalled()
    expect(mentionsPointedFile('summarize this file')).toBe(true)
    expect(mentionsPointedFile('convert that to Excel')).toBe(true)
    expect(await sharePointedFile('summarize this spreadsheet', d)).toEqual({
      ok: true,
      id: 'f_abcd1'
    })
    expect(point).toHaveBeenCalledWith('summarize this spreadsheet')
    expect(register).toHaveBeenCalledWith('C:\\Users\\ana\\Documents\\Reports\\Budget 2026.xlsx')
  })
})
