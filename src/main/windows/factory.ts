import { BrowserWindow, type BrowserWindowConstructorOptions, type WebPreferences } from 'electron'
import { join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
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

/** True for URLs our own windows may load: the dev server or bundled renderer files. */
export function isOwnRendererUrl(raw: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  try {
    const url = new URL(raw)
    if (devUrl && is.dev && url.origin === new URL(devUrl).origin) return true
    if (url.protocol === 'file:') {
      const rendererDir = resolve(__dirname, '../renderer').toLowerCase()
      return resolve(fileURLToPath(url)).toLowerCase().startsWith(rendererDir + sep)
    }
  } catch {
    /* not a URL */
  }
  return false
}
