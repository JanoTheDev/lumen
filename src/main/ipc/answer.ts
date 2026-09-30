import { ipcMain } from 'electron'
import { overlayHeightSchema, textSchema } from '@shared/ipc'
import { safeParse } from './validate'
import * as answer from '../windows/answer'

export function registerAnswerIpc(): void {
  ipcMain.on('answer:show', (_e, raw: unknown) => {
    const text = safeParse('answer:show', textSchema, raw)
    if (text === undefined) return
    // TTS is started inside the query pipeline to minimise perceived delay.
    answer.showText(text)
  })
  ipcMain.on('answer:hide', () => answer.hide())
  ipcMain.on('answer:resize', (_e, raw: unknown) => {
    const h = safeParse('answer:resize', overlayHeightSchema, raw)
    if (h === undefined) return
    answer.resize(h)
  })
}
