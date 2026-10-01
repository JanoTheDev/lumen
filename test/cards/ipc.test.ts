import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/windows/assistant', () => ({ showAnswer: vi.fn(), send: vi.fn() }))
vi.mock('../../src/main/windows/home', () => ({ hide: vi.fn() }))
vi.mock('../../src/main/windows/settings', () => ({ create: vi.fn() }))
vi.mock('../../src/main/windows/cards', () => ({}))
vi.mock('../../src/main/a11y', () => ({ announce: vi.fn() }))
vi.mock('../../src/main/actions/executor', () => ({
  executeActions: vi.fn(async () => ({ executed: 1 }))
}))
vi.mock('../../src/main/ai/memory/runtime', () => ({ onSessionEnd: vi.fn() }))

import { invokeHandler } from '../helpers/electron-mock'
import { setConfigDir } from '../../src/main/config'
import { presentCards } from '../../src/main/cards'
import { registerCardsIpc } from '../../src/main/ipc/cards'
import * as settingsWin from '../../src/main/windows/settings'
import { hotelCards } from './fixture'

// registerCardsIpc keeps card sets on disk: point it at a temp folder.
const home = mkdtempSync(join(tmpdir(), 'lumen-cards-ipc-'))
beforeAll(() => {
  setConfigDir(home)
  registerCardsIpc()
})
afterAll(() => {
  setConfigDir(null)
  rmSync(home, { recursive: true, force: true })
})

describe('cards IPC', () => {
  it('refuses bad ids and actions', async () => {
    await expect(invokeHandler('cards:get', '../x')).resolves.toBeNull()
    await expect(invokeHandler('cards:get', 'c_nothere1')).resolves.toBeNull()
    await expect(
      invokeHandler('cards:action', { id: 'c_abcd1234', action: 'pay' })
    ).resolves.toMatchObject({ ok: false, error: 'E_INVALID' })
    await expect(
      invokeHandler('cards:action', { id: 'c_abcd1234', action: 'open', extra: 1 })
    ).resolves.toMatchObject({ error: 'E_INVALID' })
  })

  it('reads a card set and opens the table', async () => {
    const r = presentCards('x', hotelCards())
    if (!r.ok) throw new Error(r.error)
    const view = (await invokeHandler('cards:get', r.id)) as { cards: unknown[] }
    expect(view.cards).toHaveLength(3)
    await invokeHandler('cards:action', { id: r.id, cardId: 'h2', action: 'compare' })
    expect(settingsWin.create).toHaveBeenCalledWith(`answer/${r.id}/table`)
    await vi.waitFor(() => expect(readdirSync(join(home, 'cards'))).toContain(`${r.id}.json`))
  })
})
