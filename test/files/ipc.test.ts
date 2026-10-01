import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
const sessionEnd = vi.hoisted(() => ({ fn: null as null | (() => void) }))
vi.mock('../../src/main/ai/memory/runtime', () => ({
  onSessionEnd: (fn: () => void) => {
    sessionEnd.fn = fn
    return () => {}
  }
}))
vi.mock('../../src/main/windows/assistant', () => ({
  get: () => ({ isDestroyed: () => false, webContents: { id: 'bar' } })
}))

import { invokeHandler, resetElectronMock } from '../helpers/electron-mock'
import { handleDrop, registerFilesIpc } from '../../src/main/files/ipc'
import { clearFiles, listFiles } from '../../src/main/files/store'

const dir = mkdtempSync(join(tmpdir(), 'lumen-ipc-'))

beforeEach(() => {
  resetElectronMock()
  clearFiles()
  registerFilesIpc()
})

describe('file drop IPC', () => {
  it('validates the payload', async () => {
    for (const bad of [
      null,
      'C:\\a.pdf',
      { path: 1 },
      { path: 'C:\\a.pdf', extra: 1 },
      { path: 'x'.repeat(2000) }
    ])
      expect(await handleDrop(bad)).toEqual({ error: 'E_INVALID' })
  })

  it('registers a file and reports refusals with the current list', async () => {
    const p = join(dir, 'a.txt')
    writeFileSync(p, 'hi')
    const ok = await handleDrop({ path: p })
    expect(ok).toEqual({
      ok: true,
      files: [expect.objectContaining({ name: 'a.txt', kind: 'text' })]
    })
    const bad = await handleDrop({ path: join(dir, 'nope.exe') })
    expect(bad).toMatchObject({ ok: false, files: [expect.objectContaining({ name: 'a.txt' })] })
  })

  it('drops from any window but the bar are refused', async () => {
    const p = join(dir, 'b.txt')
    writeFileSync(p, 'hi')
    expect(await invokeHandler('assistant:file-dropped', { path: p })).toEqual({
      error: 'E_INVALID'
    })
    expect(listFiles()).toEqual([])
  })

  it('lists, removes, and forgets everything when the conversation ends', async () => {
    const p = join(dir, 'c.txt')
    writeFileSync(p, 'hi')
    await handleDrop({ path: p })
    const [f] = (await invokeHandler('assistant:files')) as { id: string }[]
    expect(await invokeHandler('assistant:files', 'extra')).toEqual({ error: 'E_INVALID' })
    expect(await invokeHandler('assistant:file-remove', 'C:\\c.txt')).toEqual({
      error: 'E_INVALID'
    })
    expect(await invokeHandler('assistant:file-remove', f.id)).toEqual({ ok: true, files: [] })
    await handleDrop({ path: p })
    sessionEnd.fn?.()
    expect(await invokeHandler('assistant:files')).toEqual([])
  })
})
