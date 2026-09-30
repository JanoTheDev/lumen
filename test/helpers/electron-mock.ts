// Shared `electron` mock. Usage (vi.mock is hoisted, so import inside the factory):
//
//   vi.mock('electron', async () => (await import('./helpers/electron-mock')).electronModule())
//   import { electronMock, invokeHandler } from './helpers/electron-mock'
//
// The factory and the test get the same module instance, so state is shared.
import { vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FHD_100, screenAdapterFor, type DisplayLayout } from './displays'

type Handler = (event: unknown, ...args: unknown[]) => unknown
type Listener = (event: unknown, ...args: unknown[]) => void

const handlers = new Map<string, Handler>()
const listeners = new Map<string, Listener[]>()
let layout: DisplayLayout = FHD_100
let userData: string | null = null

export class BrowserWindowStub {
  static instances: BrowserWindowStub[] = []
  static getAllWindows(): BrowserWindowStub[] {
    return BrowserWindowStub.instances.filter((w) => !w.destroyed)
  }

  destroyed = false
  visible = false
  bounds = { x: 0, y: 0, width: 800, height: 600 }
  readonly webContents = {
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    openDevTools: vi.fn(),
    setWindowOpenHandler: vi.fn()
  }

  loadURL = vi.fn(async () => {})
  loadFile = vi.fn(async () => {})
  on = vi.fn(() => this)
  once = vi.fn(() => this)
  setAlwaysOnTop = vi.fn()
  setIgnoreMouseEvents = vi.fn()
  setVisibleOnAllWorkspaces = vi.fn()
  focus = vi.fn()

  constructor(public options: Record<string, unknown> = {}) {
    BrowserWindowStub.instances.push(this)
  }

  show(): void {
    this.visible = true
  }
  showInactive(): void {
    this.visible = true
  }
  hide(): void {
    this.visible = false
  }
  close(): void {
    this.destroy()
  }
  destroy(): void {
    this.destroyed = true
    this.visible = false
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible
  }
  getBounds(): typeof this.bounds {
    return { ...this.bounds }
  }
  setBounds(b: Partial<typeof this.bounds>): void {
    this.bounds = { ...this.bounds, ...b }
  }
}

function screenApi(): Record<string, unknown> {
  const a = (): ReturnType<typeof screenAdapterFor> => screenAdapterFor(layout)
  return {
    getPrimaryDisplay: () => a().getPrimaryDisplay(),
    getAllDisplays: () => a().getAllDisplays(),
    getDisplayNearestPoint: (pt: { x: number; y: number }) => a().getDisplayNearestPoint(pt),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    screenToDipPoint: (pt: { x: number; y: number }) => a().screenToDipPoint(pt),
    dipToScreenPoint: (pt: { x: number; y: number }) => a().dipToScreenPoint(pt),
    screenToDipRect: (_w: unknown, r: { x: number; y: number; width: number; height: number }) =>
      a().screenToDipRect(r),
    on: vi.fn()
  }
}

export const electronMock = {
  screen: screenApi(),
  shell: { openExternal: vi.fn<(url: string) => Promise<void>>(async () => {}) },
  ipcMain: {
    handle: vi.fn((channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
    on: vi.fn((channel: string, fn: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), fn])
    }),
    removeAllListeners: vi.fn((channel?: string) => {
      if (channel) listeners.delete(channel)
      else listeners.clear()
    })
  },
  app: {
    getPath: vi.fn<(name: string) => string>(() => {
      userData ??= mkdtempSync(join(tmpdir(), 'lumen-test-'))
      return userData
    }),
    getAppPath: vi.fn(() => '/app'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    on: vi.fn(),
    whenReady: vi.fn(async () => {}),
    quit: vi.fn()
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8').replace(/^enc:/, ''))
  },
  BrowserWindow: BrowserWindowStub
}

/** The object to return from a `vi.mock('electron', ...)` factory. */
export function electronModule(): typeof electronMock & { default: typeof electronMock } {
  return { ...electronMock, default: electronMock }
}

/** Change what `screen` reports (default: a single 1920x1080@100% display). */
export function setDisplays(next: DisplayLayout): void {
  layout = next
}

/** Call a handler registered with ipcMain.handle, as the renderer's invoke would. */
export async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no ipcMain.handle registered for "${channel}"`)
  return fn({ sender: { send: vi.fn() } }, ...args)
}

/** Deliver a renderer `send` to every ipcMain.on listener of `channel`. */
export function emitIpc(channel: string, ...args: unknown[]): void {
  const fns = listeners.get(channel)
  if (!fns?.length) throw new Error(`no ipcMain.on registered for "${channel}"`)
  for (const fn of fns) fn({ sender: { send: vi.fn() } }, ...args)
}

export function registeredChannels(): string[] {
  return [...handlers.keys(), ...listeners.keys()]
}

/** Clear handlers, windows, spies and the display layout between tests. */
export function resetElectronMock(): void {
  handlers.clear()
  listeners.clear()
  layout = FHD_100
  BrowserWindowStub.instances = []
  electronMock.shell.openExternal.mockClear()
  for (const fn of Object.values(electronMock.ipcMain)) fn.mockClear()
}
