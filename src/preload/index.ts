import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type Unsubscribe = () => void

function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): Unsubscribe {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api = {
  query: (prompt: string, opts?: { lowDetail?: boolean }) => ipcRenderer.invoke('query', prompt, opts),
  executeAction: (actions: unknown[]) => ipcRenderer.invoke('execute-action', actions),
  hideHighlights: () => ipcRenderer.invoke('hide-highlights'),
  closeHUD: () => ipcRenderer.send('close-hud'),
  onShowHighlights: (cb: (steps: unknown[]) => void) => listen('show-highlights', cb),
  onClearHighlights: (cb: () => void) => listen('clear-highlights', cb),
  onShowPointer: (cb: (data: { x: number; y: number; text: string }) => void) => listen('show-pointer', cb),
  onShowLocate: (cb: (items: Array<{ label: string; bbox: { x: number; y: number; w: number; h: number }; description?: string }>) => void) =>
    listen('show-locate', cb),
  voiceBarShow: (transcript: string) => ipcRenderer.send('voice-bar-show', transcript),
  voiceBarHide: () => ipcRenderer.send('voice-bar-hide'),
  showHUD: () => ipcRenderer.send('hud-show'),
  onVoiceUpdate: (cb: (transcript: string) => void) => listen('update', cb),
  showAnswerOverlay: (text: string) => ipcRenderer.send('show-answer-overlay', text),
  hideAnswerOverlay: () => ipcRenderer.send('hide-answer-overlay'),
  onShowAnswer: (cb: (text: string) => void) => listen('show-answer', cb),
  onCancelRequest: (cb: () => void) => listen('cancel-request', cb),
  onStartRecording: (cb: () => void) => listen('start-recording', cb),
  onStopRecording: (cb: () => void) => listen('stop-recording', cb),
  transcribe: (audio: ArrayBuffer) => ipcRenderer.invoke('transcribe', audio),
  resizeAnswerOverlay: (h: number) => ipcRenderer.send('resize-answer-overlay', h),
  getConfig: () => ipcRenderer.invoke('config-get'),
  saveConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('config-save', patch),
  openSettings: () => ipcRenderer.send('settings-open'),
  openLink: (url: string) => ipcRenderer.send('assistant:open-link', url),
  cancelCurrent: () => ipcRenderer.send('cancel-current'),
  onConfigChanged: (cb: (cfg: Record<string, unknown>) => void) => listen('config-changed', cb),
  wakeModelStatus: () => ipcRenderer.invoke('wake-model-status'),
  wakeModelInstall: () => ipcRenderer.invoke('wake-model-install'),
  onWakeModelProgress: (cb: (p: { phase: string; percent?: number; bytes?: number; total?: number; message?: string }) => void) =>
    listen('wake-model-progress', cb),
  onStatus: (cb: (m: { kind: string; text: string; step?: { index: number; total: number } }) => void) =>
    listen('status-set', cb),
  onStatusHide: (cb: () => void) => listen('status-hide', cb),
  settingsWindowClose: () => ipcRenderer.send('settings-window-close'),
  settingsWindowMinimize: () => ipcRenderer.send('settings-window-minimize'),
  settingsWindowMaximize: () => ipcRenderer.send('settings-window-maximize'),
  announceAction: (summary: string, confidence?: string) => ipcRenderer.invoke('announce-action', summary, confidence),
  ttsSpeak: (text: string) => ipcRenderer.invoke('tts-speak', text),
  onTtsAudio: (cb: (p: { mime: string; data: string }) => void) => listen('tts-audio', cb),
  guidesList: () => ipcRenderer.invoke('guides-list'),
  guidesSaveLast: (name: string) => ipcRenderer.invoke('guides-save-last', name),
  guidesReplay: (id: string) => ipcRenderer.invoke('guides-replay', id),
  guidesDelete: (id: string) => ipcRenderer.invoke('guides-delete', id),
  onRunQuery: (cb: (text: string) => void) => listen('run-query', cb),
  onDwellProgress: (cb: (data: { x: number; y: number; progress: number; active: boolean }) => void) =>
    listen('dwell-progress', cb),
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
