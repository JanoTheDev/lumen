import { ipcMain } from 'electron'
import { z } from 'zod'
import { audioSchema, textSchema } from '@shared/ipc'
import { INVALID, safeParse } from './validate'
import { loadConfig } from '../config'
import { onRecordingEnded } from '../speech/hotkey'
import { sttStatus } from '../speech/stt'
import { installLocalModel } from '../speech/stt/local-model'

const transcribeOptsSchema = z.object({ dictation: z.boolean().optional() }).strict().optional()

export interface TranscribeOptions {
  /** Dictation: punctuation-friendly prompt biased with the personal dictionary. */
  dictation?: boolean
}

export interface VoiceIpcDeps {
  speak: (text: string, voice: string) => Promise<void>
  transcribe: (audio: ArrayBuffer, opts?: TranscribeOptions) => Promise<string>
  dictate: (text: string) => Promise<{ ok: boolean; notice?: string }>
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
  ipcMain.handle('voice:transcribe', async (_event, raw: unknown, rawOpts: unknown) => {
    const audio = safeParse('voice:transcribe', audioSchema, raw)
    if (!audio) return ''
    const opts = safeParse('voice:transcribe', transcribeOptsSchema, rawOpts) ?? {}
    return deps.transcribe(audio, opts)
  })
  ipcMain.on('voice:ended', () => onRecordingEnded())
  ipcMain.handle('voice:stt-status', () => sttStatus())
  ipcMain.handle('voice:stt-install', async () => {
    try {
      await installLocalModel()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle('voice:dictate', async (_event, raw: unknown) => {
    const text = safeParse('voice:dictate', textSchema, raw)
    if (text === undefined) return INVALID
    try {
      return await deps.dictate(text)
    } catch (e) {
      console.error('[dictation] failed:', (e as Error).message)
      return { ok: false, notice: (e as Error).message }
    }
  })
}
