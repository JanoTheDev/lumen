// Tray icon: state icons for light and dark taskbars, left click toggles Home, right click
// opens the menu from tray-menu.ts.
import {
  app,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  type MenuItemConstructorOptions
} from 'electron'
import readyDark from '../../../resources/tray/ready-dark.ico?asset'
import readyLight from '../../../resources/tray/ready-light.ico?asset'
import listeningDark from '../../../resources/tray/listening-dark.ico?asset'
import listeningLight from '../../../resources/tray/listening-light.ico?asset'
import pausedDark from '../../../resources/tray/paused-dark.ico?asset'
import pausedLight from '../../../resources/tray/paused-light.ico?asset'
import errorDark from '../../../resources/tray/error-dark.ico?asset'
import errorLight from '../../../resources/tray/error-light.ico?asset'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { skillRegistry, startLesson } from '../teach'
import { onConfigPatched, patchConfig } from '../ipc/settings'
import {
  trayIconName,
  trayMenu,
  trayState,
  trayTooltip,
  type TrayAction,
  type TrayInput,
  type TrayItem
} from './tray-menu'
import { exportDiagnostics } from '../diagnostics/export'
import { openLogsFolder } from '../diagnostics/ipc'
import * as home from './home'
import * as settings from './settings'

const ICONS: Record<string, string> = {
  'ready-dark.ico': readyDark,
  'ready-light.ico': readyLight,
  'listening-dark.ico': listeningDark,
  'listening-light.ico': listeningLight,
  'paused-dark.ico': pausedDark,
  'paused-light.ico': pausedLight,
  'error-dark.ico': errorDark,
  'error-light.ico': errorLight
}

const ERROR_MS = 6000

let tray: Tray | null = null
let listening = false
let error = false
let errorTimer: NodeJS.Timeout | null = null
let pausedByUser = false
let lastIcon = ''

export function get(): Tray | null {
  return tray
}

function input(): TrayInput {
  const cfg = loadConfig()
  let guides: TrayInput['guides'] = []
  try {
    // Saved guides are user lessons now (07 T19).
    guides = (skillRegistry()?.userLessons() ?? []).map(({ lesson }) => ({
      id: lesson.id,
      name: lesson.title
    }))
  } catch {
    /* registry not loaded yet: no submenu entries */
  }
  return {
    hotkey: cfg.hotkey,
    wakeEnabled: cfg.wakeWord.enabled,
    pausedByUser,
    dwellEnabled: cfg.dwellClick.enabled,
    listening,
    error,
    guides
  }
}

/** Whether the taskbar is dark. Lumen's own theme does not change the taskbar. */
const darkTaskbar = (): boolean =>
  nativeTheme.shouldUseDarkColors || nativeTheme.shouldUseHighContrastColors

function refresh(): void {
  if (!tray || tray.isDestroyed()) return
  const i = input()
  const name = trayIconName(trayState(i), darkTaskbar())
  if (name !== lastIcon) {
    tray.setImage(nativeImage.createFromPath(ICONS[name]))
    lastIcon = name
  }
  tray.setToolTip(trayTooltip(i))
}

/** "Pause listening" in the tray or Home: turns the wake word off and remembers why. */
export async function setListeningPaused(paused: boolean): Promise<void> {
  pausedByUser = paused
  await patchConfig({ wakeWord: { enabled: !paused } })
  refresh()
}

function run(action: TrayAction): void {
  if (action.startsWith('guide:')) {
    startLesson(action.slice('guide:'.length))
    return
  }
  switch (action) {
    case 'home':
      home.show(tray?.getBounds() ?? null)
      break
    case 'ask':
      home.show(tray?.getBounds() ?? null)
      home.send('home:ask')
      break
    case 'pause':
      void setListeningPaused(true)
      break
    case 'resume':
    case 'wake-on':
      void setListeningPaused(false)
      break
    case 'dwell':
      void patchConfig({ dwellClick: { enabled: !loadConfig().dwellClick.enabled } })
      break
    case 'lessons':
      settings.create('settings/lessons')
      break
    case 'settings':
      settings.create('settings')
      break
    case 'onboarding':
      settings.create('onboarding')
      break
    case 'logs':
      void openLogsFolder()
      break
    case 'diagnostics':
      void exportDiagnostics()
      break
    case 'quit':
      app.quit()
      break
  }
}

function toMenu(items: TrayItem[]): MenuItemConstructorOptions[] {
  return items.map((it) => {
    if (it.type === 'separator') return { type: 'separator' }
    const { action } = it
    return {
      label: it.label,
      type: it.type === 'checkbox' ? 'checkbox' : it.submenu ? 'submenu' : 'normal',
      checked: it.checked,
      submenu: it.submenu ? toMenu(it.submenu) : undefined,
      click: action ? () => run(action) : undefined
    }
  })
}

function setError(on: boolean): void {
  error = on
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = on ? setTimeout(() => setError(false), ERROR_MS) : null
  refresh()
}

export function create(): void {
  tray = new Tray(nativeImage.createFromPath(ICONS[trayIconName('ready', darkTaskbar())]))
  lastIcon = trayIconName('ready', darkTaskbar())
  // Built on demand so guide names and toggles are always current.
  tray.on('right-click', () =>
    tray?.popUpContextMenu(Menu.buildFromTemplate(toMenu(trayMenu(input()))))
  )
  tray.on('click', () => home.toggle(tray?.getBounds() ?? null))
  nativeTheme.on('updated', refresh)
  onConfigPatched((next) => {
    if (next.wakeWord.enabled) pausedByUser = false
    refresh()
  })
  bus.on('voice.started', () => {
    listening = true
    refresh()
  })
  const stop = (): void => {
    listening = false
    refresh()
  }
  bus.on('voice.stopped', stop)
  bus.on('voice.cancelled', stop)
  bus.on('query.started', () => error && setError(false))
  bus.on('query.failed', (e) => {
    if (!e.cancelled) setError(true)
  })
  refresh()
}
