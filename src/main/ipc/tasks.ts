// Background tasks IPC (08 T29, CONTRACTS C11): the Home flyout's Tasks list. tasks:changed
// carries the whole list (it is short) to the Home window, and to the panel window, whose task
// chat list follows it (also on foreground task and Claude session changes). The task chat view (08 T43) in the
// panel window: tasks:chat / tasks:chats read, tasks:watch subscribes the open view to
// tasks:chat pushes, tasks:steer and tasks:control act on the task.
import { ipcMain } from 'electron'
import { z } from 'zod'
import { bgTaskAnswerSchema, bgTaskIdSchema } from '@shared/ipc'
import {
  chatControlSchema,
  chatIdSchema,
  chatSteerSchema,
  chatWatchSchema
} from '@shared/task-chat'
import { backgroundManager } from '../agent-mode/background'
import {
  chatForTask,
  chatList,
  controlChat,
  openChat,
  steerChat,
  watchChat
} from '../agent-mode/transcript-wire'
import { transcripts } from '../agent-mode/transcript-hub'
import { bus } from '../bus'
import { onSessionChange } from '../claude-code'
import * as home from '../windows/home'
import * as panel from '../windows/settings'
import { INVALID, safeParse } from './validate'

/** tasks:open takes a Tasks-list id, a chat id, or "all" (the chat view's list). */
export const taskOpenSchema = z.union([chatIdSchema, z.literal('all')])

const PUSH_MS = 150

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
    const id = safeParse('tasks:open', taskOpenSchema, raw)
    if (id === undefined) return INVALID
    if (id === 'all') {
      openChat('')
      return { ok: true }
    }
    // A Tasks-list row opens its chat (a Claude session's row: the session's chat).
    const chat = id.startsWith('bg_') ? chatForTask(id) : id
    if (!chat) return { ok: false }
    if (id.startsWith('bg_')) m.markSeen(id)
    openChat(chat)
    return { ok: true }
  })
  ipcMain.handle('tasks:chats', (_e, ...args: unknown[]) => (args.length ? INVALID : chatList()))
  ipcMain.handle('tasks:chat', (_e, raw: unknown) => {
    const id = safeParse('tasks:chat', chatIdSchema, raw)
    if (id === undefined) return INVALID
    if (id.startsWith('bg_')) m.markSeen(id)
    return transcripts().view(id)
  })
  ipcMain.handle('tasks:watch', (_e, ...args: unknown[]) => {
    const v = safeParse('tasks:watch', chatWatchSchema, args)
    if (!v) return INVALID
    return { ok: watchChat(v[0], v[1]) }
  })
  ipcMain.handle('tasks:steer', (_e, raw: unknown) => {
    const v = safeParse('tasks:steer', chatSteerSchema, raw)
    if (!v) return INVALID
    return steerChat(v.id, v.text)
  })
  ipcMain.handle('tasks:control', (_e, raw: unknown) => {
    const v = safeParse('tasks:control', chatControlSchema, raw)
    if (!v) return INVALID
    return controlChat(v.id, v.op)
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
  const changed = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const list = m.list()
      home.send('tasks:changed', list)
      panel.send('tasks:changed', list)
    }, PUSH_MS)
  }
  bus.on('task.changed', changed)
  bus.on('agent.task', changed)
  // Only a phase or title change moves a Claude session's row.
  const seen = new Map<string, string>()
  onSessionChange((v) => {
    const key = `${v.phase}|${v.title}|${v.pending ? 1 : 0}`
    if (seen.get(v.id) === key) return
    seen.set(v.id, key)
    changed()
  })
}
