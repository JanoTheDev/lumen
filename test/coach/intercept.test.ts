import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HELPERS_DEFAULTS, type HelpersConfig } from '../../src/shared/config'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

let helpers: HelpersConfig = { ...HELPERS_DEFAULTS }
const saveConfig = vi.fn((p: { helpers?: Partial<HelpersConfig> }) => {
  helpers = { ...helpers, ...p.helpers }
})
vi.mock('../../src/main/config', () => ({
  loadConfig: () => ({ helpers }),
  saveConfig: (p: { helpers?: Partial<HelpersConfig> }) => saveConfig(p)
}))
vi.mock('../../src/main/agent/instance', () => ({ getAgent: () => null }))
vi.mock('../../src/main/a11y', () => ({ announce: vi.fn() }))
vi.mock('../../src/main/teach', () => ({ skillRegistry: () => null }))
vi.mock('../../src/main/windows/assistant', () => ({ requestConfirm: vi.fn(async () => false) }))
vi.mock('../../src/main/actions/executor', () => ({ executeActions: vi.fn() }))
vi.mock('../../src/main/ipc/settings', () => ({ onConfigPatched: vi.fn() }))
const focusOn = vi.fn(async () => 'Focus mode on.')
vi.mock('../../src/main/focus', () => ({
  focusOn: (o: unknown) => focusOn(o),
  focusOff: () => 'Showing everything.',
  installFocus: vi.fn()
}))

import { interceptHelpers } from '../../src/main/coach'

describe('interceptHelpers', () => {
  beforeEach(() => {
    helpers = { ...HELPERS_DEFAULTS }
    saveConfig.mockClear()
  })

  it('leaves other utterances alone', () => {
    expect(interceptHelpers('open notepad')).toBeUndefined()
  })

  it('focus mode answers locally', async () => {
    expect(await interceptHelpers('only show the viewport')).toEqual({
      mode: 'answer',
      text: 'Focus mode on.'
    })
    expect(focusOn).toHaveBeenCalledWith({ region: 'viewport', level: undefined })
    expect(interceptHelpers('show everything')).toEqual({
      mode: 'answer',
      text: 'Showing everything.'
    })
  })

  it('"undo that" stays the app’s Ctrl+Z unless Lumen just acted', () => {
    helpers.undo = true
    expect(interceptHelpers('undo that')).toBeUndefined()
  })

  it('features that are off fall through or say how to turn them on', () => {
    expect(interceptHelpers('what changed')).toBeUndefined()
    expect(interceptHelpers('explain this error')).toBeUndefined()
    expect(interceptHelpers('yes')).toBeUndefined()
    expect(interceptHelpers('what did I learn this week')).toMatchObject({
      text: expect.stringContaining('journal is off')
    })
  })

  it('reading level is saved as a setting', async () => {
    expect(await interceptHelpers('explain simpler')).toMatchObject({
      text: expect.stringContaining('plain and simple')
    })
    expect(saveConfig).toHaveBeenCalledWith({ helpers: { readingLevel: 'plain' } })
  })

  it('"turn on shortcut tips" switches the coach on', () => {
    expect(interceptHelpers('turn on shortcut tips')).toEqual({
      mode: 'answer',
      text: 'Shortcut tips are on.'
    })
    expect(helpers.shortcutCoach).toBe(true)
  })
})
