import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebPreferences
} from 'electron'
import { join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { is } from '@electron-toolkit/utils'

export type RendererEntry = 'settings' | 'assistant' | 'screen' | 'panel' | 'a11y'

/** Locked-down webPreferences shared by every Lumen window. */
export function securePrefs(): WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    // Overlays are never focused; without this their animations stall in the background.
    backgroundThrottling: false
  }
}

let gpuLogged = false

/** Logs the GPU feature status once so jank reports can be checked against it. */
function logGpuStatus(): void {
  if (gpuLogged) return
  gpuLogged = true
  const s = app.getGPUFeatureStatus()
  console.log(
    `[gpu] gpu_compositing=${s.gpu_compositing} webgl=${s.webgl} rasterization=${s.rasterization}`
  )
}

export function createWindow(opts: BrowserWindowConstructorOptions): BrowserWindow {
  logGpuStatus()
  return new BrowserWindow({ ...opts, webPreferences: securePrefs() })
}

/** Loads a renderer entry; `hash` (without #) selects a route inside it, e.g. "/settings". */
export function loadRenderer(win: BrowserWindow, entry: RendererEntry, hash?: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devUrl) {
    const base = `${devUrl}/${entry}.html`
    win.loadURL(hash ? `${base}#${hash}` : base)
  } else {
    win.loadFile(join(__dirname, `../renderer/${entry}.html`), hash ? { hash } : undefined)
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
      return resolve(fileURLToPath(url))
        .toLowerCase()
        .startsWith(rendererDir + sep)
    }
  } catch {
    /* not a URL */
  }
  return false
}
