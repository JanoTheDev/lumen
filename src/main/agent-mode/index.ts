// Safety wiring (08 Phase 1): grants file, audit log, the bar's confirm card as the policy's
// confirm UI, IPC for the grants list and the audit viewer, and "what did you just do".
// Background tasks (08 Phase 5): persisted task list and the tasks:* IPC.
// Skill making by voice (11 T09-T11) hooks in here: it follows agent runs.
import { ipcMain } from 'electron'
import { dirname, join } from 'path'
import { auditQuerySchema, grantScopeSchema } from '@shared/ipc'
import { configPath, loadConfig } from '../config'
import { INVALID, safeParse } from '../ipc/validate'
import * as assistant from '../windows/assistant'
import { onBroadcast } from '../windows/registry'
import { installAudit, lastTaskSummary, listAudit, setAuditStoreTypedText } from '../audit/log'
import { setConfirmUi } from './confirm'
import { grants, installGrants } from './grants'
import { installBackground } from './background'
import { registerTasksIpc } from '../ipc/tasks'
import { installSkillCreation, interceptSkillCreation, recordedSkill } from '../skills/creation'
import { setSkillRecordingSink, startSkillRecording } from '../teach'

export function installAgentMode(): void {
  const root = dirname(configPath())
  installGrants(join(root, 'grants.json'))
  const { audit } = loadConfig()
  setAuditStoreTypedText(audit.storeTypedText)
  installAudit(join(root, 'audit'), audit.retentionDays)
  onBroadcast('settings:changed', () => setAuditStoreTypedText(loadConfig().audit.storeTypedText))
  installBackground(join(root, 'tasks'))
  setConfirmUi({
    ask: (card) => assistant.requestConfirm(card),
    confirm: () => assistant.command({ type: 'confirm' })
  })
  // Skills made by voice (11 T09-T11): from the last run, "when I say …", the step recorder.
  installSkillCreation(startSkillRecording)
  setSkillRecordingSink(recordedSkill)
}

export function registerAgentModeIpc(): void {
  registerTasksIpc()
  ipcMain.handle('agent:grants-list', (_e, ...args: unknown[]) =>
    args.length ? INVALID : grants().list()
  )
  ipcMain.handle('agent:grants-revoke', (_e, raw: unknown) => {
    const scope = safeParse('agent:grants-revoke', grantScopeSchema, raw)
    if (scope === undefined) return INVALID
    return { ok: grants().revoke(scope) }
  })
  ipcMain.handle('audit:list', (_e, raw: unknown) => {
    const q = safeParse('audit:list', auditQuerySchema, raw)
    if (!q) return INVALID
    return listAudit(q.date, q.taskId)
  })
}

const WHAT_DID_YOU_DO_RE =
  /^(what (did|have) you (just )?(do|done)|what did you just change|what happened just now)$/

/** Whole-utterance voice commands of the safety layer and skill making; undefined = not ours. */
export function interceptAgentMode(prompt: string): unknown | undefined {
  const skill = interceptSkillCreation(prompt)
  if (skill !== undefined) return skill
  const words = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!WHAT_DID_YOU_DO_RE.test(words)) return undefined
  const text = lastTaskSummary()
  return { mode: 'answer', text, spoken: text.replace(/^- /gm, '') }
}
