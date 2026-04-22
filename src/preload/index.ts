import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  query: (prompt: string, opts?: { lowDetail?: boolean }) => ipcRenderer.invoke('query', prompt, opts),
  executeAction: (actions: unknown[]) => ipcRenderer.invoke('execute-action', actions),
  hideHighlights: () => ipcRenderer.invoke('hide-highlights'),
  closeHUD: () => ipcRenderer.send('close-hud'),
  onShowHighlights: (cb: (steps: unknown[]) => void) => {
    ipcRenderer.on('show-highlights', (_e, steps) => cb(steps))
  },
  onClearHighlights: (cb: () => void) => {
    ipcRenderer.on('clear-highlights', () => cb())
  },
  onShowPointer: (cb: (data: { x: number; y: number; text: string }) => void) => {
    ipcRenderer.on('show-pointer', (_e, data) => cb(data))
  },
  onShowLocate: (cb: (items: Array<{ label: string; bbox: [number, number, number, number]; description?: string }>) => void) => {
    ipcRenderer.on('show-locate', (_e, items) => cb(items))
  },
  voiceBarShow: (transcript: string) => ipcRenderer.send('voice-bar-show', transcript),
  voiceBarHide: () => ipcRenderer.send('voice-bar-hide'),
  showHUD: () => ipcRenderer.send('hud-show'),
  onVoiceUpdate: (cb: (transcript: string) => void) => {
    ipcRenderer.on('update', (_e, t) => cb(t))
  },
  showAnswerOverlay: (text: string) => ipcRenderer.send('show-answer-overlay', text),
  hideAnswerOverlay: () => ipcRenderer.send('hide-answer-overlay'),
  onShowAnswer: (cb: (text: string) => void) => {
    ipcRenderer.on('show-answer', (_e, text) => cb(text))
  },
  onCancelRequest: (cb: () => void) => {
    ipcRenderer.on('cancel-request', () => cb())
  },
  onStartRecording: (cb: () => void) => {
    ipcRenderer.on('start-recording', () => cb())
  },
  onStopRecording: (cb: () => void) => {
    ipcRenderer.on('stop-recording', () => cb())
  },
  transcribe: (audio: ArrayBuffer) => ipcRenderer.invoke('transcribe', audio),
  resizeAnswerOverlay: (h: number) => ipcRenderer.send('resize-answer-overlay', h),
  getConfig: () => ipcRenderer.invoke('config-get'),
  saveConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('config-save', patch),
  openSettings: () => ipcRenderer.send('settings-open'),
  cancelCurrent: () => ipcRenderer.send('cancel-current'),
  onConfigChanged: (cb: (cfg: Record<string, unknown>) => void) => {
    ipcRenderer.on('config-changed', (_e, cfg) => cb(cfg))
  },
  wakeModelStatus: () => ipcRenderer.invoke('wake-model-status'),
  wakeModelInstall: () => ipcRenderer.invoke('wake-model-install'),
  onWakeModelProgress: (cb: (p: { phase: string; percent?: number; bytes?: number; total?: number; message?: string }) => void) => {
    ipcRenderer.on('wake-model-progress', (_e, p) => cb(p))
  },
  onStatus: (cb: (m: { kind: string; text: string; step?: { index: number; total: number } }) => void) => {
    ipcRenderer.on('status-set', (_e, m) => cb(m))
  },
  onStatusHide: (cb: () => void) => {
    ipcRenderer.on('status-hide', () => cb())
  },
  settingsWindowClose: () => ipcRenderer.send('settings-window-close'),
  settingsWindowMinimize: () => ipcRenderer.send('settings-window-minimize'),
  settingsWindowMaximize: () => ipcRenderer.send('settings-window-maximize'),
  announceAction: (summary: string, confidence?: string) => ipcRenderer.invoke('announce-action', summary, confidence),
  ttsSpeak: (text: string) => ipcRenderer.invoke('tts-speak', text),
  onTtsAudio: (cb: (p: { mime: string; data: string }) => void) => {
    ipcRenderer.on('tts-audio', (_e, p) => cb(p))
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
