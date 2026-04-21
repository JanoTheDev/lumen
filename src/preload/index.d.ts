import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      query: (prompt: string, opts?: { lowDetail?: boolean }) => Promise<unknown>
      executeAction: (actions: unknown[]) => Promise<{ done?: boolean; cancelled?: boolean; reached_bottom?: boolean }>
      hideHighlights: () => Promise<void>
      closeHUD: () => void
      onShowHighlights: (cb: (steps: unknown[]) => void) => void
      onClearHighlights: (cb: () => void) => void
      onShowPointer: (cb: (data: { x: number; y: number; text: string }) => void) => void
      showAnswerOverlay: (text: string) => void
      hideAnswerOverlay: () => void
      onShowAnswer: (cb: (text: string) => void) => void
      onStartRecording: (cb: () => void) => void
      onStopRecording: (cb: () => void) => void
      transcribe: (audio: ArrayBuffer) => Promise<string>
      resizeAnswerOverlay: (h: number) => void
    }
  }
}
