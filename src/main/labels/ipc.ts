// Settings → Smart helpers → Community labels IPC (11 T13).
import { ipcMain } from 'electron'
import type { LabelEntryView } from '@shared/channels'
import { labelAppSchema, labelEditSchema } from '@shared/ipc'
import { INVALID, safeParse } from '../ipc/validate'
import { labelsChanged, labelStore, saveLabelsJson } from '.'
import { labelKey } from './store'
import { exportLabelsHandoff } from '../teach/handoff'

export function registerLabelsIpc(): void {
  ipcMain.handle('labels:apps', () => labelStore()?.apps() ?? [])
  ipcMain.handle('labels:entries', (_e, raw: unknown): LabelEntryView[] | typeof INVALID => {
    const app = safeParse('labels:entries', labelAppSchema, raw)
    if (!app) return INVALID
    return (labelStore()?.entries(app) ?? []).map((l) => ({
      key: labelKey(l),
      role: l.role,
      label: l.label,
      ...(l.description ? { description: l.description } : {}),
      source: l.source,
      confidence: l.confidence,
      ...(l.origin ? { origin: l.origin } : {})
    }))
  })
  ipcMain.handle('labels:edit', (_e, raw: unknown) => {
    const edit = safeParse('labels:edit', labelEditSchema, raw)
    if (!edit) return INVALID
    const ok = !!labelStore()?.edit(edit.app, edit.key, edit.label)
    labelsChanged()
    return { ok }
  })
  ipcMain.handle('labels:remove-app', (_e, raw: unknown) => {
    const app = safeParse('labels:remove-app', labelAppSchema, raw)
    if (!app) return INVALID
    const ok = !!labelStore()?.removeApp(app)
    labelsChanged()
    return { ok }
  })
  ipcMain.handle('labels:save-json', (e, raw: unknown) => {
    const app = safeParse('labels:save-json', labelAppSchema, raw)
    if (!app) return INVALID
    return saveLabelsJson(app, e.sender)
  })
  ipcMain.handle('labels:export-lumen', (e, raw: unknown) => {
    const app = safeParse('labels:export-lumen', labelAppSchema, raw)
    if (!app) return INVALID
    return exportLabelsHandoff(app, e.sender)
  })
}
