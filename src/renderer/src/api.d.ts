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

type Unsubscribe = () => void

interface ElectronAPI {
  query: (prompt: string, opts?: { lowDetail?: boolean }) => Promise<unknown>
  executeAction: (actions: unknown[]) => Promise<unknown>
  hideHighlights: () => Promise<void>
  closeHUD: () => void
  onShowHighlights: (cb: (steps: unknown[]) => void) => Unsubscribe
  onClearHighlights: (cb: () => void) => Unsubscribe
  onShowPointer: (cb: (data: { x: number; y: number; text: string }) => void) => Unsubscribe
  onShowLocate: (cb: (items: Array<{ label: string; bbox: { x: number; y: number; w: number; h: number }; description?: string }>) => void) => Unsubscribe
  voiceBarShow: (transcript: string) => void
  voiceBarHide: () => void
  showHUD: () => void
  onVoiceUpdate: (cb: (transcript: string) => void) => Unsubscribe
  showAnswerOverlay: (text: string) => void
  hideAnswerOverlay: () => void
  onShowAnswer: (cb: (text: string) => void) => Unsubscribe
  onCancelRequest: (cb: () => void) => Unsubscribe
  onStartRecording: (cb: () => void) => Unsubscribe
  onStopRecording: (cb: () => void) => Unsubscribe
  transcribe: (audio: ArrayBuffer) => Promise<string>
  resizeAnswerOverlay: (h: number) => void
  getConfig: () => Promise<Record<string, unknown>>
  saveConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>
  openSettings: () => void
  openLink: (url: string) => void
  cancelCurrent: () => void
  onConfigChanged: (cb: (cfg: Record<string, unknown>) => void) => Unsubscribe
  wakeModelStatus: () => Promise<WakeModelStatus>
  wakeModelInstall: () => Promise<{ ok: boolean; error?: string }>
  onWakeModelProgress: (cb: (p: WakeModelProgress) => void) => Unsubscribe
  onStatus: (cb: (m: { kind: string; text: string; step?: { index: number; total: number } }) => void) => Unsubscribe
  onStatusHide: (cb: () => void) => Unsubscribe
  settingsWindowClose: () => void
  settingsWindowMinimize: () => void
  settingsWindowMaximize: () => void
  announceAction: (summary: string, confidence?: string) => Promise<{ delayMs: number }>
  ttsSpeak: (text: string) => Promise<{ ok: boolean; error?: string }>
  onTtsAudio: (cb: (p: { mime: string; data: string }) => void) => Unsubscribe
  guidesList: () => Promise<Array<{ id: string; name: string; task: string; steps: Array<{ label: string }>; createdAt: number }>>
  guidesSaveLast: (name: string) => Promise<{ id?: string; name?: string; error?: string }>
  guidesReplay: (id: string) => Promise<{ id?: string; error?: string }>
  guidesDelete: (id: string) => Promise<{ ok: boolean }>
  onRunQuery: (cb: (text: string) => void) => Unsubscribe
  onDwellProgress: (cb: (data: { x: number; y: number; progress: number; active: boolean }) => void) => Unsubscribe
}

interface Window {
  api: ElectronAPI
}
