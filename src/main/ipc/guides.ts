import { ipcMain } from 'electron'
import { guideIdSchema, nameSchema } from '@shared/ipc'
import type { SavedGuide } from '@shared/types'
import { safeParse } from './validate'
import { deleteSavedGuide, listSavedGuides } from '../guides/store'

export interface GuidesIpcDeps {
  saveLast: (name: string) => SavedGuide | null
  replay: (id: string) => SavedGuide | null
}

export function registerGuidesIpc(deps: GuidesIpcDeps): void {
  ipcMain.handle('guides:list', () => listSavedGuides())
  ipcMain.handle('guides:save-last', (_e, raw: unknown) => {
    const name = safeParse('guides:save-last', nameSchema.optional(), raw)
    const g = deps.saveLast(name ?? '')
    return g ?? { error: 'no guide to save — run a guide first' }
  })
  ipcMain.handle('guides:replay', (_e, raw: unknown) => {
    const id = safeParse('guides:replay', guideIdSchema, raw)
    return (id && deps.replay(id)) || { error: 'not found' }
  })
  ipcMain.handle('guides:delete', (_e, raw: unknown) => {
    const id = safeParse('guides:delete', guideIdSchema, raw)
    return { ok: !!id && deleteSavedGuide(id) }
  })
}
