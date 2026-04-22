// Global `window.api` surface exposed by src/preload/index.ts.
// Keep in sync with the `api` object there.

interface WakeModelStatus { installed: boolean; path: string }
interface WakeModelProgress {
  phase: 'downloading' | 'extracting' | 'done' | 'error'
  percent?: number
  bytes?: number
  total?: number
  message?: string
}

interface ElectronAPI {
  query: (prompt: string, opts?: { lowDetail?: boolean }) => Promise<unknown>
  executeAction: (actions: unknown[]) => Promise<unknown>
  hideHighlights: () => Promise<void>
  closeHUD: () => void
  onShowHighlights: (cb: (steps: unknown[]) => void) => void
  onClearHighlights: (cb: () => void) => void
  onShowPointer: (cb: (data: { x: number; y: number; text: string }) => void) => void
  onShowLocate: (cb: (items: Array<{ label: string; bbox: [number, number, number, number]; description?: string }>) => void) => void
  voiceBarShow: (transcript: string) => void
  voiceBarHide: () => void
  showHUD: () => void
  onVoiceUpdate: (cb: (transcript: string) => void) => void
  showAnswerOverlay: (text: string) => void
  hideAnswerOverlay: () => void
  onShowAnswer: (cb: (text: string) => void) => void
  onCancelRequest: (cb: () => void) => void
  onStartRecording: (cb: () => void) => void
  onStopRecording: (cb: () => void) => void
  transcribe: (audio: ArrayBuffer) => Promise<string>
  resizeAnswerOverlay: (h: number) => void
  getConfig: () => Promise<Record<string, unknown>>
  saveConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>
  openSettings: () => void
  cancelCurrent: () => void
  onConfigChanged: (cb: (cfg: Record<string, unknown>) => void) => void
  wakeModelStatus: () => Promise<WakeModelStatus>
  wakeModelInstall: () => Promise<{ ok: boolean; error?: string }>
  onWakeModelProgress: (cb: (p: WakeModelProgress) => void) => void
  onStatus: (cb: (m: { kind: string; text: string; step?: { index: number; total: number } }) => void) => void
  onStatusHide: (cb: () => void) => void
  settingsWindowClose: () => void
  settingsWindowMinimize: () => void
  settingsWindowMaximize: () => void
  announceAction: (summary: string, confidence?: string) => Promise<{ delayMs: number }>
  ttsSpeak: (text: string) => Promise<{ ok: boolean; error?: string }>
  onTtsAudio: (cb: (p: { mime: string; data: string }) => void) => void
  guidesList: () => Promise<Array<{ id: string; name: string; task: string; steps: Array<{ label: string }>; createdAt: number }>>
  guidesSaveLast: (name: string) => Promise<{ id?: string; name?: string; error?: string }>
  guidesReplay: (id: string) => Promise<{ id?: string; error?: string }>
  guidesDelete: (id: string) => Promise<{ ok: boolean }>
  onRunQuery: (cb: (text: string) => void) => void
  onDwellProgress: (cb: (data: { x: number; y: number; progress: number; active: boolean }) => void) => void
}

interface Window {
  api: ElectronAPI
}
