// connectors:* (08 T19): MCP servers for Settings → Connectors. Secrets go in, never out.
import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { connectors } from '../connectors'
import { inputSchema, SERVER_ID_RE } from '../connectors/store'
import { INVALID, safeParse } from './validate'

const idSchema = z.string().regex(SERVER_ID_RE)

export function registerConnectorsIpc(): void {
  ipcMain.handle('connectors:list', () => connectors().list())
  ipcMain.handle('connectors:add', (_e, raw: unknown) => {
    const req = safeParse('connectors:add', inputSchema, raw)
    return req ? connectors().add(req) : INVALID
  })
  ipcMain.handle('connectors:update', (_e, raw: unknown) => {
    const req = safeParse('connectors:update', inputSchema, raw)
    return req ? connectors().update(req) : INVALID
  })
  ipcMain.handle('connectors:remove', (_e, raw: unknown) => {
    const id = safeParse('connectors:remove', idSchema, raw)
    return id ? connectors().remove(id) : INVALID
  })
  ipcMain.handle('connectors:test', (_e, raw: unknown) => {
    const id = safeParse('connectors:test', idSchema, raw)
    return id ? connectors().test(id) : INVALID
  })
  ipcMain.handle('connectors:tools', (_e, raw: unknown) => {
    const id = safeParse('connectors:tools', idSchema, raw)
    return id ? connectors().tools(id) : INVALID
  })
  // Opens the provider's sign-in page in the default browser and waits (up to 5 minutes) for
  // the redirect to 127.0.0.1.
  ipcMain.handle('connectors:sign-in', (_e, raw: unknown) => {
    const id = safeParse('connectors:sign-in', idSchema, raw)
    return id
      ? connectors().signIn(id, { open: (url) => shell.openExternal(url.toString()) })
      : INVALID
  })
  ipcMain.handle('connectors:sign-out', (_e, raw: unknown) => {
    const id = safeParse('connectors:sign-out', idSchema, raw)
    return id ? connectors().signOut(id) : INVALID
  })
}
