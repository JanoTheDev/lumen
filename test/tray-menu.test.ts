import { describe, expect, it } from 'vitest'
import {
  trayIconName,
  trayMenu,
  trayState,
  trayTooltip,
  type TrayInput
} from '../src/main/windows/tray-menu'

const base: TrayInput = {
  hotkey: 'Ctrl+Shift+Space',
  wakeEnabled: false,
  pausedByUser: false,
  dwellEnabled: false,
  listening: false,
  error: false,
  guides: []
}

const labels = (i: TrayInput): string[] => trayMenu(i).map((m) => m.label ?? '-')

describe('tray menu', () => {
  it('names the app, state and hotkey in the tooltip', () => {
    expect(trayTooltip(base)).toBe('Lumen — Ready (Ctrl+Shift+Space)')
    expect(trayTooltip({ ...base, listening: true })).toBe('Lumen — Listening (Ctrl+Shift+Space)')
  })

  it('picks the state: error over listening over paused', () => {
    expect(trayState({ ...base, error: true, listening: true })).toBe('error')
    expect(trayState({ ...base, listening: true, pausedByUser: true })).toBe('listening')
    expect(trayState({ ...base, pausedByUser: true })).toBe('paused')
    // Wake word never turned on is not "paused".
    expect(trayState(base)).toBe('ready')
    expect(trayIconName('paused', true)).toBe('paused-dark.ico')
    expect(trayIconName('ready', false)).toBe('ready-light.ico')
  })

  it('matches the menu order', () => {
    expect(labels(base)).toEqual([
      'Open Lumen',
      'Ask…',
      '-',
      'Listen for the wake word',
      'Dwell click',
      'Lessons',
      '-',
      'Settings',
      'Help and setup',
      '-',
      'Quit Lumen'
    ])
  })

  it('offers pause or resume by listening state', () => {
    expect(labels({ ...base, wakeEnabled: true })[3]).toBe('Pause listening')
    expect(labels({ ...base, pausedByUser: true })[3]).toBe('Resume listening')
  })

  it('lists saved guides under Lessons, capped', () => {
    const guides = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, name: `Guide ${i}` }))
    const lessons = trayMenu({ ...base, guides }).find((m) => m.label === 'Lessons')
    expect(lessons?.submenu).toHaveLength(10)
    expect(lessons?.submenu?.[0]).toEqual({ label: 'Guide 0', action: 'guide:g0' })
    const empty = trayMenu(base).find((m) => m.label === 'Lessons')
    expect(empty?.submenu?.map((m) => m.action)).toEqual(['lessons'])
  })

  it('shows dwell as a checkbox', () => {
    const dwell = trayMenu({ ...base, dwellEnabled: true }).find((m) => m.action === 'dwell')
    expect(dwell).toMatchObject({ type: 'checkbox', checked: true })
  })
})
