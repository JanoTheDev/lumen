import { ipcMain } from 'electron'
import { z } from 'zod'
import { audioSchema, sayDoneSchema, textSchema } from '@shared/ipc'
import { bus } from '../bus'
import { INVALID, safeParse } from './validate'
import { loadConfig } from '../config'
import { onRecordingEnded, onSpeakingChanged, onTurnEnded } from '../speech/hotkey'
import { prepareStt, sttStatus } from '../speech/stt'
import { onConfigPatched } from './settings'
import { installLocalModel } from '../speech/stt/local-model'
import { onWakePcm, wakeFeedWanted } from '../speech/wake'
import { handleBargeIn } from '../speech/wake/handlers'
import { registerDictationLogIpc } from './dictation-log'
import { registerSnippetsIpc } from './dictation-snippets'

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
  registerDictationLogIpc()
  registerSnippetsIpc()
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
  // A new voice language may need the other offline model.
  onConfigPatched((next, prev) => {
    if (next.voice.language !== prev.voice.language || next.voice.stt !== prev.voice.stt)
      prepareStt()
  })
  ipcMain.on('voice:ended', () => onRecordingEnded())
  ipcMain.on('voice:wake-pcm', (_e, raw: unknown) => onWakePcm(raw))
  ipcMain.on('voice:barge-in', () => handleBargeIn())
  ipcMain.on('voice:speaking', (_e, raw: unknown) => {
    if (typeof raw === 'boolean') onSpeakingChanged(raw)
  })
  ipcMain.on('voice:say-done', (_e, raw: unknown) => {
    const done = safeParse('voice:say-done', sayDoneSchema, raw)
    if (done) bus.emit({ type: 'speech.finished', ...done })
  })
  // Also handled by ipc/hud (the bar); here a conversation listens again.
  ipcMain.on('assistant:close', () => onTurnEnded())
  ipcMain.handle('voice:wake-state', () => ({ listen: wakeFeedWanted() }))
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
