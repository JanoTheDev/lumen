import { ipcMain } from 'electron'
import { textSchema } from '@shared/ipc'
import { safeParse } from './validate'
import * as assistant from '../windows/assistant'
import { cardsForAnswer } from '../cards/answer-link'

export function registerAnswerIpc(): void {
  ipcMain.on('answer:show', (_e, raw: unknown) => {
    const text = safeParse('answer:show', textSchema, raw)
    if (text === undefined) return
    // TTS is started inside the query pipeline to minimise perceived delay.
    // A research task's reply keeps the cards it presented (05 T39).
    assistant.showAnswer(text, cardsForAnswer(text))
  })
}
