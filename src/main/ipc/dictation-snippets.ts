// Voice snippets (04 T38) for Settings → Voice: list and save the whole list.
import { ipcMain } from 'electron'
import { snippetsSaveSchema } from '@shared/ipc'
import { INVALID, safeParse } from './validate'
import { loadSnippets, saveSnippets } from '../speech/dictation/snippets'

export function registerSnippetsIpc(): void {
  ipcMain.handle('dictation:snippets', () => loadSnippets())
  ipcMain.handle('dictation:snippets-save', (_e, raw: unknown) => {
    const list = safeParse('dictation:snippets-save', snippetsSaveSchema, raw)
    if (!list) return INVALID
    try {
      return { ok: true, snippets: saveSnippets(list) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
