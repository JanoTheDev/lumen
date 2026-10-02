// Settings → cost estimate (usage:get) and the Usage page (05 T44): report, drill-down calls,
// CSV export, per-task and per-automation spend; usage:changed tells the panel to re-read.
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { usageCallsSchema, usageReportSchema, usageTasksSchema } from '@shared/ipc'
import type { UsageLimitRow, UsageLimitsView, UsageRange } from '@shared/usage'
import { usageOverview } from '../ai/cost'
import { enableUsageLog, flushUsage } from '../ai/usage-log'
import { backgroundManager, notice, startBackgroundTask } from '../agent-mode/background'
import { transcripts } from '../agent-mode/transcript-hub'
import { getBuddy, listBuddies } from '../buddies'
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
import { installUsageLimits, limitState, type LimitScope } from '../usage/limits'
import { setUsageVoiceCardsFresh, setUsageVoiceScopes, type NamedScope } from '../usage/voice'
import { currentCards } from '../cards'
import { FOLLOWUP_TTL_MS } from '../cards/turn'
import * as panel from '../windows/settings'
import { INVALID, safeParse } from './validate'

const PUSH_MS = 2000

const names: UsageNames = {
  automation: (id) => automations().get(id)?.name,
  task: (id) => backgroundManager().get(id)?.title ?? transcripts().meta(id)?.title,
  buddy: (id) => getBuddy(id)?.name
}

/** Lets a feature outside this module name its ids (buddies). */
export function setUsageNameLookup(more: Partial<UsageNames>): void {
  Object.assign(names, more)
}

function limitRow(scope: LimitScope, name: string): UsageLimitRow {
  const st = limitState(scope)
  return {
    kind: scope.kind,
    id: scope.kind === 'overall' ? '' : scope.id,
    name,
    usd: st.usd,
    tokens: st.tokens,
    ...(st.cap.usd !== undefined ? { capUsd: st.cap.usd } : {}),
    ...(st.cap.tokens !== undefined ? { capTokens: st.cap.tokens } : {}),
    ratio: st.ratio,
    level: st.level,
    ...(st.estimated ? { estimated: st.estimated } : {})
  }
}

/** Settings → Usage limits: this month against each cap. */
function usageLimits(): UsageLimitsView {
  return {
    overall: limitRow({ kind: 'overall' }, 'All of Lumen'),
    automations: automations()
      .all()
      .map((a) => limitRow({ kind: 'automation', id: a.id }, a.name)),
    buddies: listBuddies().map((b) => limitRow({ kind: 'buddy', id: b.id }, b.name))
  }
}

function namedScopes(): NamedScope[] {
  return [
    ...automations()
      .all()
      .map((a) => ({ kind: 'automation' as const, id: a.id, name: a.name })),
    ...listBuddies().map((b) => ({ kind: 'buddy' as const, id: b.id, name: b.name }))
  ]
}

/** A limit notice as a finished row in the Tasks list (no model call, takes no slot). */
function limitNotice(text: string): void {
  startBackgroundTask({
    prompt: text,
    title: 'Monthly usage limit',
    origin: 'agent',
    run: async () => ({ status: 'done', summary: text })
  })
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
  ipcMain.handle('usage:limits', (_e, ...args: unknown[]) =>
    args.length ? INVALID : usageLimits()
  )

  installUsageLimits({
    buddy: (id) => {
      const b = getBuddy(id)
      return b
        ? {
            name: b.name,
            perMonthUsd: b.budget.perMonthUsd,
            perMonthTokens: b.budget.perMonthTokens
          }
        : null
    },
    automationName: (id) => automations().get(id)?.name,
    notify: limitNotice,
    warn: (text) => notice(text)
  })
  setUsageVoiceScopes(namedScopes)
  // "how much does the hotel cost" with fresh cards is a card follow-up, not a usage question.
  setUsageVoiceCardsFresh(() => {
    const set = currentCards()
    return !!set && Date.now() - set.createdAt <= FOLLOWUP_TTL_MS
  })

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
