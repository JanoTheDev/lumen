// IPC of the bar's file drop (08 T21). assistant:file-dropped is reachable only through the
// preload's dropFile (it is not in the invoke table) and only from the assistant bar window.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { FILE_DROPPED_CHANNEL, type FileDropResult } from '@shared/channels'
import { fileDropSchema, fileIdSchema } from '@shared/ipc'
import { onSessionEnd } from '../ai/memory/runtime'
import { log } from '../logger'
import * as assistant from '../windows/assistant'
import { INVALID, safeParse } from '../ipc/validate'
import { resetAttachState } from './attach'
import { clearFiles, listFiles, registerFile, removeFile } from './store'

const fromBar = (e: IpcMainInvokeEvent): boolean => {
  const w = assistant.get()
  return !!w && !w.isDestroyed() && e.sender === w.webContents
}

const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`

export async function handleDrop(raw: unknown): Promise<FileDropResult | typeof INVALID> {
  const payload = safeParse(FILE_DROPPED_CHANNEL, fileDropSchema, raw)
  if (!payload) return INVALID
  const r = await registerFile(payload.path)
  if (!r.ok) {
    log('fail', `file drop refused: ${r.error}`)
    return { ok: false, error: r.error, files: listFiles() }
  }
  log('plan', `file shared: ${r.file.kind} ${kb(r.file.size)} as ${r.file.id}`)
  return { ok: true, files: listFiles() }
}

export function forgetFiles(): void {
  clearFiles()
  resetAttachState()
}

export function registerFilesIpc(): void {
  ipcMain.handle(FILE_DROPPED_CHANNEL, (e, raw: unknown) =>
    fromBar(e) ? handleDrop(raw) : INVALID
  )
  ipcMain.handle('assistant:files', (_e, ...args: unknown[]) =>
    args.length ? INVALID : listFiles()
  )
  ipcMain.handle('assistant:file-remove', (_e, raw: unknown): FileDropResult | typeof INVALID => {
    const id = safeParse('assistant:file-remove', fileIdSchema, raw)
    if (id === undefined) return INVALID
    const ok = removeFile(id)
    return ok
      ? { ok: true, files: listFiles() }
      : { ok: false, error: 'That file was already removed.', files: listFiles() }
  })
  // Files belong to one conversation: "new topic", idle end and quit forget them.
  onSessionEnd(() => forgetFiles())
}
