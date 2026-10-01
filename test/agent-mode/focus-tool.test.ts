import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
const focusOn = vi.fn<(o: unknown) => Promise<string>>(async () => 'Focus mode on.')
const focusOff = vi.fn(() => 'Showing everything.')
vi.mock('../../src/main/focus', () => ({
  focusOn: (o: unknown) => focusOn(o),
  focusOff: () => focusOff()
}))

import { createHandlers, type TaskEnv } from '../../src/main/agent-mode/handlers'
import { FOREGROUND_TOOLS, INPUT_TOOLS } from '../../src/main/agent-mode/tools'

const ctx = { signal: new AbortController().signal } as never

describe('focus_mode agent tool', () => {
  it('is a foreground tool that sends no input', () => {
    expect(FOREGROUND_TOOLS).toContain('focus_mode')
    expect(INPUT_TOOLS).not.toContain('focus_mode')
  })

  it('turns focus mode on for a named region or the window, and off', async () => {
    const h = createHandlers({} as TaskEnv)
    expect(await h.focus_mode({ on: true, region: 'viewport' }, ctx)).toEqual({
      content: [{ type: 'text', text: 'Focus mode on.' }]
    })
    expect(focusOn).toHaveBeenLastCalledWith({ region: 'viewport' })
    await h.focus_mode({ on: true, region: ' ' }, ctx)
    expect(focusOn).toHaveBeenLastCalledWith({ region: undefined })
    expect(await h.focus_mode({ on: false, region: '' }, ctx)).toEqual({
      content: [{ type: 'text', text: 'Showing everything.' }]
    })
  })
})
