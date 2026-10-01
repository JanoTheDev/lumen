// PDF through Chromium's own printer: the document's HTML (a temp file) is loaded in a hidden
// window with no scripts and no network (its own in-memory session refuses every request that
// is not the page itself) and printed with printToPDF. No PDF library in the bundle. The page
// is Letter where the system's region uses it (US, Canada, Mexico, …), else A4.
import { randomBytes } from 'crypto'
import { app, BrowserWindow, session } from 'electron'
import { rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const PARTITION = 'lumen-pdf'
const LOAD_TIMEOUT_MS = 15_000
let sessionReady = false
/** The pages the session may load right now (one per PDF being printed). */
const allowed = new Set<string>()

function pdfSession(): Electron.Session {
  const s = session.fromPartition(PARTITION, { cache: false })
  if (!sessionReady) {
    sessionReady = true
    s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !allowed.has(d.url) }))
    s.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  }
  return s
}

/** Regions whose paper size is Letter (CLDR). */
const LETTER_REGIONS = new Set([
  'US',
  'CA',
  'MX',
  'PH',
  'PR',
  'CL',
  'CO',
  'CR',
  'DO',
  'GT',
  'PA',
  'SV',
  'VE',
  'BZ'
])

/** Letter for a locale whose region uses it ("en-US", "es-MX"), else A4. Pure. */
export function pageSizeFor(locale: string | undefined): 'Letter' | 'A4' {
  const region = /[-_]([A-Za-z]{2})(?:$|[-_.@])/.exec(locale ?? '')?.[1]?.toUpperCase()
  return region && LETTER_REGIONS.has(region) ? 'Letter' : 'A4'
}

function systemLocale(): string {
  try {
    return app.getSystemLocale() || app.getLocale()
  } catch {
    return ''
  }
}

export async function htmlToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      session: pdfSession(),
      sandbox: true,
      javascript: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })
  const file = join(tmpdir(), `lumen-pdf-${randomBytes(6).toString('hex')}.html`)
  const url = pathToFileURL(file).href
  try {
    await writeFile(file, html, 'utf8')
    allowed.add(url)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      win.loadURL(url),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('the page did not load')), LOAD_TIMEOUT_MS)
      })
    ]).finally(() => clearTimeout(timer))
    return await win.webContents.printToPDF({
      printBackground: true,
      pageSize: pageSizeFor(systemLocale()),
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    })
  } finally {
    allowed.delete(url)
    if (!win.isDestroyed()) win.destroy()
    await rm(file, { force: true }).catch(() => {})
  }
}
