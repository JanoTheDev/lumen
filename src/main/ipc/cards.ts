// Answer cards IPC (05 Phase R): `cards:get` reads one stored card set, `cards:action` runs a
// card button. Installs the real ports (bar, panel window, executor, notes, announce).
import { ipcMain } from 'electron'
import { z } from 'zod'
import { CARD_ACTIONS, CARDS_ID_RE } from '@shared/cards'
import { announce } from '../a11y'
import { executeActions } from '../actions/executor'
import { onSessionEnd } from '../ai/memory/runtime'
import { cardAction, cardsView, endCardsConversation, setCardsPorts } from '../cards'
import { noteSaver } from '../web/notes'
import * as assistant from '../windows/assistant'
import '../windows/cards'
import * as home from '../windows/home'
import * as settingsWin from '../windows/settings'
import { INVALID, safeParse } from './validate'

const idSchema = z.string().regex(CARDS_ID_RE)
const actionSchema = z.strictObject({
  id: idSchema,
  cardId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional(),
  action: z.enum([...CARD_ACTIONS, 'show-all'])
})

export function registerCardsIpc(): void {
  setCardsPorts({
    showAnswer: (text, cardsId) => assistant.showAnswer(text, cardsId),
    async openUrl(url) {
      const r = await executeActions([{ type: 'open_url', url }], {
        origin: 'user-direct',
        preview: false
      })
      return !r.denied && !r.blocked && r.executed > 0
    },
    async saveNote(note) {
      const save = noteSaver()
      return save ? await save(note) : false
    },
    openPanel(route) {
      home.hide()
      settingsWin.create(route)
    },
    runQuery: (text) => assistant.send('assistant:run-query', text),
    say: (text) => announce(text, { kind: 'command' })
  })
  onSessionEnd(() => endCardsConversation())

  ipcMain.handle('cards:get', (_e, raw: unknown) => {
    const id = safeParse('cards:get', idSchema, raw)
    return id === undefined ? null : cardsView(id)
  })
  ipcMain.handle('cards:action', async (_e, raw: unknown) => {
    const req = safeParse('cards:action', actionSchema, raw)
    if (!req) return { ...INVALID, ok: false }
    return cardAction(req)
  })
}
