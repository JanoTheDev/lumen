// Background tasks IPC (08 T29, CONTRACTS C11): the Home flyout's Tasks list. tasks:changed
// carries the whole list (it is short) to the Home window.
import { ipcMain } from 'electron'
import { bgTaskAnswerSchema, bgTaskIdSchema } from '@shared/ipc'
import type { BackgroundTask } from '@shared/types'
import { backgroundManager } from '../agent-mode/background'
import { bus } from '../bus'
import * as assistant from '../windows/assistant'
import * as home from '../windows/home'
import { INVALID, safeParse } from './validate'

const PUSH_MS = 150

/** What tasks:open shows on the assistant bar. */
export function taskCard(t: BackgroundTask): string {
  if (t.question && (t.phase === 'asking' || t.phase === 'needs-foreground'))
    return `**${t.title}** asks: ${t.question.text}`
  if (t.result) {
    const report = t.result.report ? `\n\n${t.result.report}` : ''
    return `**${t.title}**\n\n${t.result.summary}${report}`
  }
  const last = t.progress[t.progress.length - 1]
  const state: Record<BackgroundTask['phase'], string> = {
    queued: 'Waiting for a free slot.',
    running: last ? `Working: ${last}` : 'Working.',
    'needs-foreground': 'Waiting to use the mouse.',
    asking: 'Waiting for your answer.',
    done: 'Done.',
    failed: 'It failed.',
    cancelled: 'Cancelled.',
    interrupted: 'Stopped when Lumen closed. Run it again from the Tasks list.'
  }
  return `**${t.title}**\n\n${state[t.phase]}`
}

export function registerTasksIpc(): void {
  const m = backgroundManager()
  ipcMain.handle('tasks:list', (_e, ...args: unknown[]) => {
    if (args.length) return INVALID
    // Looking at the list counts as seeing the finished tasks (the tray badge clears).
    const list = m.list()
    m.markSeen()
    return list
  })
  ipcMain.handle('tasks:cancel', (_e, raw: unknown) => {
    const id = safeParse('tasks:cancel', bgTaskIdSchema, raw)
    if (id === undefined) return INVALID
    return { ok: m.cancel(id) }
  })
  ipcMain.handle('tasks:open', (_e, raw: unknown) => {
    const id = safeParse('tasks:open', bgTaskIdSchema, raw)
    if (id === undefined) return INVALID
    const t = m.get(id)
    if (!t) return { ok: false }
    m.markSeen(id)
    assistant.showAnswer(taskCard(t))
    return { ok: true }
  })
  ipcMain.handle('tasks:answer', (_e, ...args: unknown[]) => {
    const v = safeParse('tasks:answer', bgTaskAnswerSchema, args)
    if (!v) return INVALID
    return { ok: m.answer(v[0], v[1]) }
  })
  ipcMain.handle('tasks:run-again', (_e, raw: unknown) => {
    const id = safeParse('tasks:run-again', bgTaskIdSchema, raw)
    if (id === undefined) return INVALID
    const t = m.runAgain(id)
    return t ? { ok: true, id: t.id } : { ok: false }
  })

  let timer: NodeJS.Timeout | null = null
  bus.on('task.changed', () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      home.send('tasks:changed', m.list())
    }, PUSH_MS)
  })
}
