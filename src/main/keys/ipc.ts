// keys:* channels. The renderer only ever sees where a key came from and its last 4 characters.
import { ipcMain } from 'electron'
import { z } from 'zod'
import { INVALID, safeParse } from '../ipc/validate'
import { clearKey, keyStatus, setKey, testKey } from './vault'

const providerSchema = z.enum(['anthropic', 'openai'])
const setSchema = z
  .object({
    provider: providerSchema,
    key: z
      .string()
      .trim()
      .min(20)
      .max(300)
      .regex(/^[A-Za-z0-9_\-.]+$/)
  })
  .strict()

export function registerKeysIpc(): void {
  ipcMain.handle('keys:status', () => keyStatus())
  ipcMain.handle('keys:set', (_e, raw: unknown) => {
    const req = safeParse('keys:set', setSchema, raw)
    if (!req) {
      return { ok: false, persisted: false, error: 'That doesn’t look like an API key.' }
    }
    return setKey(req.provider, req.key)
  })
  ipcMain.handle('keys:clear', (_e, raw: unknown) => {
    const provider = safeParse('keys:clear', providerSchema, raw)
    if (!provider) return INVALID
    return { ok: clearKey(provider) }
  })
  ipcMain.handle('keys:test', (_e, raw: unknown) => {
    const provider = safeParse('keys:test', providerSchema, raw)
    if (!provider) return INVALID
    return testKey(provider)
  })
}
