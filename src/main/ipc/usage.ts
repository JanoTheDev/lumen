// Settings → cost estimate (usage:get) and the Usage page (05 T44): report, drill-down calls,
// CSV export, per-task and per-automation spend; usage:changed tells the panel to re-read.
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { usageCallsSchema, usageReportSchema, usageTasksSchema } from '@shared/ipc'
import type { UsageRange } from '@shared/usage'
import { usageOverview } from '../ai/cost'
import { enableUsageLog, flushUsage } from '../ai/usage-log'
import { backgroundManager } from '../agent-mode/background'
import { transcripts } from '../agent-mode/transcript-hub'
import { LUMEN_FOLDER } from '../docs-out/place'
import { log } from '../logger'
import { automations } from '../routines'
import { dayKey, onUsageRecorded } from '../usage/ledger'
import {
  usageByAutomation,
  usageCalls,
  usageCsvFor,
  usageForTasks,
  usageReport,
  type UsageNames
} from '../usage/report'
import * as panel from '../windows/settings'
import { INVALID, safeParse } from './validate'

const PUSH_MS = 2000

const names: UsageNames = {
  automation: (id) => automations().get(id)?.name,
  task: (id) => backgroundManager().get(id)?.title ?? transcripts().meta(id)?.title
}

/** Lets a feature outside this module name its ids (buddies). */
export function setUsageNameLookup(more: Partial<UsageNames>): void {
  Object.assign(names, more)
}

async function exportCsv(
  e: IpcMainInvokeEvent,
  range: UsageRange
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const dir = join(app.getPath('documents'), LUMEN_FOLDER)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // the dialog starts elsewhere
  }
  const opts: Electron.SaveDialogOptions = {
    title: 'Export usage',
    defaultPath: join(dir, `lumen-usage-${range}-${dayKey(Date.now())}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  }
  const parent = BrowserWindow.fromWebContents(e.sender)
  const pick = parent
    ? await dialog.showSaveDialog(parent, opts)
    : await dialog.showSaveDialog(opts)
  if (pick.canceled || !pick.filePath) return { ok: false, error: 'cancelled' }
  try {
    writeFileSync(pick.filePath, usageCsvFor(range), 'utf8')
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  log('done', 'usage exported')
  return { ok: true, path: pick.filePath }
}

export function registerUsageIpc(): void {
  enableUsageLog()
  ipcMain.handle('usage:get', () => usageOverview())
  ipcMain.handle('usage:report', (_e, raw: unknown) => {
    const v = safeParse('usage:report', usageReportSchema, raw)
    return v ? usageReport(v.range, names) : INVALID
  })
  ipcMain.handle('usage:calls', (_e, raw: unknown) => {
    const v = safeParse('usage:calls', usageCallsSchema, raw)
    return v ? usageCalls(v.range, v.filter) : INVALID
  })
  ipcMain.handle('usage:export', (e, raw: unknown) => {
    const v = safeParse('usage:export', usageReportSchema, raw)
    return v ? exportCsv(e, v.range) : INVALID
  })
  ipcMain.handle('usage:tasks', (_e, raw: unknown) => {
    const v = safeParse('usage:tasks', usageTasksSchema, raw)
    return v ? usageForTasks(v.ids) : INVALID
  })
  ipcMain.handle('usage:by-automation', (_e, ...args: unknown[]) =>
    args.length ? INVALID : usageByAutomation()
  )

  let timer: NodeJS.Timeout | null = null
  onUsageRecorded(() => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      panel.send('usage:changed')
    }, PUSH_MS)
    timer.unref?.()
  })
  app.on('before-quit', () => flushUsage())
}
