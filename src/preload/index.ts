import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS, type LumenApi } from '@shared/channels'

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const sendAllowed = new Set<string>(SEND_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

// Only channels in the shared table are reachable from a renderer.
const lumen: LumenApi = {
  invoke(channel, ...args) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`unknown channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  send(channel, ...args) {
    if (!sendAllowed.has(channel)) throw new Error(`unknown channel: ${channel}`)
    ipcRenderer.send(channel, ...args)
  },
  on(channel, cb) {
    if (!eventAllowed.has(channel)) throw new Error(`unknown channel: ${channel}`)
    const handler = (_e: IpcRendererEvent, ...args: unknown[]): void =>
      (cb as (...a: unknown[]) => void)(...args)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

contextBridge.exposeInMainWorld('lumen', lumen)
