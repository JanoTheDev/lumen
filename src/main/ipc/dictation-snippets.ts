// Voice snippets (04 T38) for Settings → Voice: list and save the whole list. Also the
// personal dictionary file (04 T39): export to / merge from a JSON file the user picks.
import { BrowserWindow, app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { snippetsSaveSchema } from '@shared/ipc'
import { INVALID, safeParse } from './validate'
import { loadConfig } from '../config'
import { log } from '../logger'
import { patchConfig } from './settings'
import { loadSnippets, saveSnippets } from '../speech/dictation/snippets'
import { dictionaryFileSchema, exportDictionary, mergeImport } from '../speech/dictation/dictionary'

const MAX_IMPORT_BYTES = 1024 * 1024
const FILTERS = [{ name: 'Lumen dictionary', extensions: ['json'] }]

function parentOf(e: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(e.sender) ?? undefined
}

async function exportFile(e: IpcMainInvokeEvent): Promise<{ ok: boolean; error?: string }> {
  const opts: Electron.SaveDialogOptions = {
    title: 'Export dictionary',
    defaultPath: join(app.getPath('documents'), 'lumen-dictionary.json'),
    filters: FILTERS
  }
  const parent = parentOf(e)
  const pick = parent
    ? await dialog.showSaveDialog(parent, opts)
    : await dialog.showSaveDialog(opts)
  if (pick.canceled || !pick.filePath) return { ok: false, error: 'cancelled' }
  const data = exportDictionary(loadConfig().dictation)
  writeFileSync(pick.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  log('done', 'dictionary exported')
  return { ok: true }
}

async function importFile(
  e: IpcMainInvokeEvent
): Promise<{ ok: boolean; added?: number; error?: string }> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Import dictionary',
    properties: ['openFile'],
    filters: FILTERS
  }
  const parent = parentOf(e)
  const pick = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts)
  const path = pick.filePaths[0]
  if (pick.canceled || !path) return { ok: false, error: 'cancelled' }
  if (statSync(path).size > MAX_IMPORT_BYTES) return { ok: false, error: 'That file is too big.' }
  let parsed
  try {
    parsed = dictionaryFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return { ok: false, error: 'That file is not a Lumen dictionary.' }
  }
  if (!parsed.success) return { ok: false, error: 'That file is not a Lumen dictionary.' }
  const cur = loadConfig().dictation
  const merged = mergeImport(cur, parsed.data)
  const { added, ...lists } = merged
  const saved = await patchConfig({ dictation: { ...cur, ...lists } })
  if (saved === INVALID) return { ok: false, error: 'Could not save the dictionary.' }
  log('done', `dictionary imported (${added} new)`)
  return { ok: true, added }
}

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
  ipcMain.handle('dictation:dictionary-export', async (e) => {
    try {
      return await exportFile(e)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('dictation:dictionary-import', async (e) => {
    try {
      return await importFile(e)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
