import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writeText } = vi.hoisted(() => ({ writeText: vi.fn() }))
vi.mock('electron', async () => {
  const m = (await import('../../helpers/electron-mock')).electronModule()
  return { ...m, clipboard: { writeText }, default: { ...m.default, clipboard: { writeText } } }
})

import { invokeHandler, resetElectronMock } from '../../helpers/electron-mock'
import { saveConfig, setConfigDir } from '../../../src/main/config'
import { registerDictationLogIpc } from '../../../src/main/ipc/dictation-log'
import { recordDictation } from '../../../src/main/speech/dictation/history'

const INVALID = { error: 'E_INVALID' }
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-dictation-ipc-'))
  setConfigDir(dir)
  resetElectronMock()
  writeText.mockClear()
  registerDictationLogIpc()
})
afterEach(() => {
  setConfigDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('dictation history / notes / stats ipc', () => {
  it('rejects bad ids and empty notes', async () => {
    for (const ch of [
      'dictation:history-delete',
      'dictation:history-copy',
      'dictation:history-insert',
      'notes:delete',
      'notes:copy'
    ])
      expect(await invokeHandler(ch, '../x')).toEqual(INVALID)
    expect(await invokeHandler('notes:add', '   ')).toEqual(INVALID)
    expect(await invokeHandler('notes:add', 'x'.repeat(10_001))).toEqual(INVALID)
    expect(await invokeHandler('notes:update', 'nope', 'text')).toEqual(INVALID)
  })

  it('notes: add, list, copy, update, delete', async () => {
    const added = (await invokeHandler('notes:add', 'Buy milk')) as { note: { id: string } }
    const id = added.note.id
    expect(await invokeHandler('notes:list')).toMatchObject([{ id, text: 'Buy milk' }])
    expect(await invokeHandler('notes:copy', id)).toEqual({ ok: true })
    expect(writeText).toHaveBeenCalledWith('Buy milk')
    expect(await invokeHandler('notes:update', id, 'Buy oat milk')).toEqual({ ok: true })
    expect(await invokeHandler('notes:delete', id)).toEqual({ ok: true })
    expect(await invokeHandler('notes:list')).toEqual([])
  })

  it('history: list, copy, delete, clear', async () => {
    recordDictation({ raw: 'hello', text: 'Hello.' })
    const view = (await invokeHandler('dictation:history')) as {
      enabled: boolean
      entries: Array<{ id: string }>
    }
    expect(view.enabled).toBe(true)
    const id = view.entries[0].id
    expect(await invokeHandler('dictation:history-copy', id)).toEqual({ ok: true })
    expect(writeText).toHaveBeenCalledWith('Hello.')
    expect(await invokeHandler('dictation:history-delete', id)).toEqual({ ok: true })
    recordDictation({ raw: 'again', text: 'Again.' })
    expect(await invokeHandler('dictation:history-clear')).toEqual({ ok: true })
    expect(await invokeHandler('dictation:history')).toMatchObject({ entries: [] })
  })

  it('stats: show flag from config, reset', async () => {
    recordDictation({ raw: 'one two three', text: 'One two three.' })
    expect(await invokeHandler('dictation:stats')).toMatchObject({ show: false, totalWords: 3 })
    saveConfig({ dictation: { showStats: true } })
    expect(await invokeHandler('dictation:stats')).toMatchObject({ show: true })
    expect(await invokeHandler('dictation:stats-reset')).toEqual({ ok: true })
    expect(await invokeHandler('dictation:stats')).toMatchObject({ totalWords: 0 })
  })
})
