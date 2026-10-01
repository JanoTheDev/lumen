import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNELS,
  FILE_DROPPED_CHANNEL,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  type FileDropResult,
  type LumenApi
} from '@shared/channels'

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
  },
  // Only a real File (a drop) has a path; page script cannot pass one of its own.
  dropFile(file) {
    let path = ''
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      path = ''
    }
    if (!path) {
      const r: FileDropResult = { ok: false, error: 'That is not a file on this PC.', files: [] }
      return Promise.resolve(r)
    }
    return ipcRenderer.invoke(FILE_DROPPED_CHANNEL, { path })
  }
}

contextBridge.exposeInMainWorld('lumen', lumen)
