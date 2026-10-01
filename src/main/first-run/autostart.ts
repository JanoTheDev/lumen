// Start at login (config system.startAtLogin): one HKCU Run entry named "Lumen", which the
// uninstaller removes. Only the installed build registers itself; dev and portable never do.
import { app } from 'electron'
import { isPortable } from './portable'

export const LOGIN_ITEM_NAME = 'Lumen'
export const HIDDEN_ARG = '--hidden'

export interface LoginItemApi {
  setLoginItemSettings: (s: Electron.Settings) => void
  getLoginItemSettings: (o?: Electron.LoginItemSettingsOptions) => Electron.LoginItemSettings
}

export function autostartSupported(packaged = app.isPackaged): boolean {
  return packaged && !isPortable() && process.platform === 'win32'
}

/** Makes the Run entry match `enabled`. Returns false when this build can't register. */
export function applyAutostart(
  enabled: boolean,
  api: LoginItemApi = app,
  supported = autostartSupported()
): boolean {
  if (!supported) return false
  const opts = { path: process.execPath, args: [HIDDEN_ARG], name: LOGIN_ITEM_NAME }
  const current = api.getLoginItemSettings(opts).openAtLogin
  if (current !== enabled) api.setLoginItemSettings({ ...opts, openAtLogin: enabled })
  return true
}

/** Lumen was started by Windows at sign-in: stay in the tray. */
export function startedHidden(argv: string[] = process.argv): boolean {
  return argv.includes(HIDDEN_ARG)
}
