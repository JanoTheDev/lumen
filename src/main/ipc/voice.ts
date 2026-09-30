import { ipcMain } from 'electron'
import { audioSchema, textSchema } from '@shared/ipc'
import { INVALID, safeParse } from './validate'
import { loadConfig } from '../config'

export interface VoiceIpcDeps {
  speak: (text: string, voice: string) => Promise<void>
  transcribe: (audio: ArrayBuffer) => Promise<string>
}

export function registerVoiceIpc(deps: VoiceIpcDeps): void {
  ipcMain.handle('voice:speak', async (_e, raw: unknown) => {
    const text = safeParse('voice:speak', textSchema, raw)
    if (text === undefined) return INVALID
    const cfg = loadConfig()
    if (!text || !text.trim()) return { ok: false, error: 'empty text' }
    try {
      await deps.speak(text.trim(), cfg.voice.ttsVoice)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle('voice:transcribe', async (_event, raw: unknown) => {
    const audio = safeParse('voice:transcribe', audioSchema, raw)
    if (!audio) return ''
    return deps.transcribe(audio)
  })
}
