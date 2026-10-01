// styles:* (reply styles): the installed styles and the one in use, for Settings → Skills.
import { ipcMain } from 'electron'
import { z } from 'zod'
import { activeStyle, setActiveStyle, styles } from '../ai/style-runtime'
import { INVALID, safeParse } from './validate'

const setSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(64),
    level: z.string().max(30).optional()
  })
  .strict()
  .nullable()

export function registerStylesIpc(): void {
  ipcMain.handle('styles:list', () => ({ styles: styles(), active: activeStyle() }))
  ipcMain.handle('styles:set', async (_e, raw: unknown) => {
    const s = safeParse('styles:set', setSchema, raw)
    if (s === undefined) return INVALID
    if (s) {
      const info = styles().find((x) => x.name === s.name)
      if (!info) return { ok: false, error: 'No style with this name.' }
      if (!info.enabled) return { ok: false, error: 'This style is switched off.' }
      if (s.level && !info.levels.includes(s.level))
        return { ok: false, error: 'This style has no such level.' }
    }
    return (await setActiveStyle(s)) ? { ok: true } : { ok: false, error: 'Not saved.' }
  })
}
