// Tray icon state, tooltip and right-click menu as plain data (no Electron), so the rules
// are testable; tray.ts turns them into a Tray and a Menu.

export type TrayState = 'ready' | 'listening' | 'paused' | 'error'

export type TrayAction =
  | 'home'
  | 'ask'
  | 'pause'
  | 'resume'
  | 'wake-on'
  | 'dwell'
  | 'lessons'
  | 'settings'
  | 'onboarding'
  | 'logs'
  | 'diagnostics'
  | 'quit'
  | `guide:${string}`

export interface TrayItem {
  label?: string
  action?: TrayAction
  type?: 'separator' | 'checkbox'
  checked?: boolean
  submenu?: TrayItem[]
}

export interface TrayInput {
  hotkey: string
  wakeEnabled: boolean
  /** The user paused listening from the tray or Home (wake word turned off by them). */
  pausedByUser: boolean
  dwellEnabled: boolean
  listening: boolean
  error: boolean
  guides: { id: string; name: string }[]
}

const STATE_TEXT: Record<TrayState, string> = {
  ready: 'Ready',
  listening: 'Listening',
  paused: 'Paused',
  error: 'Something went wrong'
}

export function trayState(i: TrayInput): TrayState {
  if (i.error) return 'error'
  if (i.listening) return 'listening'
  if (i.pausedByUser && !i.wakeEnabled) return 'paused'
  return 'ready'
}

/** "Lumen — Ready (Ctrl+Shift+Space)". */
export function trayTooltip(i: TrayInput): string {
  return `Lumen — ${STATE_TEXT[trayState(i)]} (${i.hotkey})`
}

/** Icon file for a state on a dark or light taskbar. */
export function trayIconName(state: TrayState, darkTaskbar: boolean): string {
  return `${state}-${darkTaskbar ? 'dark' : 'light'}.ico`
}

const MAX_GUIDES = 8

export function trayMenu(i: TrayInput): TrayItem[] {
  const listen: TrayItem = i.wakeEnabled
    ? { label: 'Pause listening', action: 'pause' }
    : i.pausedByUser
      ? { label: 'Resume listening', action: 'resume' }
      : { label: 'Listen for the wake word', action: 'wake-on' }
  const guides: TrayItem[] = i.guides
    .slice(0, MAX_GUIDES)
    .map((g) => ({ label: g.name, action: `guide:${g.id}` }))
  return [
    { label: 'Open Lumen', action: 'home' },
    { label: 'Ask…', action: 'ask' },
    { type: 'separator' },
    listen,
    { label: 'Dwell click', type: 'checkbox', checked: i.dwellEnabled, action: 'dwell' },
    {
      label: 'Lessons',
      submenu: [
        ...guides,
        ...(guides.length ? [{ type: 'separator' } as TrayItem] : []),
        { label: 'All lessons and saved guides…', action: 'lessons' }
      ]
    },
    { type: 'separator' },
    { label: 'Settings', action: 'settings' },
    {
      label: 'Help and setup',
      submenu: [
        { label: 'Setup and tour', action: 'onboarding' },
        { type: 'separator' },
        { label: 'Open logs folder', action: 'logs' },
        { label: 'Export diagnostics…', action: 'diagnostics' }
      ]
    },
    { type: 'separator' },
    { label: 'Quit Lumen', action: 'quit' }
  ]
}
