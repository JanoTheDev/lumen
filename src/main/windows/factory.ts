import { BrowserWindow, type BrowserWindowConstructorOptions, type WebPreferences } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

export type RendererEntry = 'index' | 'highlight' | 'answeroverlay' | 'settings' | 'status' | 'dwellring'

/** Locked-down webPreferences shared by every Lumen window. */
export function securePrefs(): WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
  }
}

export function createWindow(opts: BrowserWindowConstructorOptions): BrowserWindow {
  return new BrowserWindow({ ...opts, webPreferences: securePrefs() })
}

export function loadRenderer(win: BrowserWindow, entry: RendererEntry): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devUrl) {
    win.loadURL(entry === 'index' ? devUrl : `${devUrl}/${entry}.html`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${entry}.html`))
  }
}
