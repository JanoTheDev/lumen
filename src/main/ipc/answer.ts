import { ipcMain } from 'electron'
import { textSchema } from '@shared/ipc'
import { safeParse } from './validate'
import * as assistant from '../windows/assistant'

export function registerAnswerIpc(): void {
  ipcMain.on('answer:show', (_e, raw: unknown) => {
    const text = safeParse('answer:show', textSchema, raw)
    if (text === undefined) return
    // TTS is started inside the query pipeline to minimise perceived delay.
    assistant.showAnswer(text)
  })
}
