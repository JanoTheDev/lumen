// The app-pack registry is read from disk on first use (or a moment after start), not by
// installTeach itself.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => home.dir }
})
vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('../../src/main/config', async () => {
  const { makeConfig } = await import('../helpers/fixtures')
  return { loadConfig: () => makeConfig() }
})
vi.mock('../../src/main/a11y', () => ({ announce: vi.fn(), setLessonActiveProbe: vi.fn() }))
vi.mock('../../src/main/a11y/focus-events', () => ({ wantFocusEvents: vi.fn() }))
vi.mock('../../src/main/query/pipeline', () => ({ setTeachHandler: vi.fn() }))

import { SkillRegistry } from '../../src/main/teach/registry'
import { installTeach, skillRegistry } from '../../src/main/teach'

afterAll(() => vi.useRealTimers())

describe('teach registry', () => {
  it('loads on first use, once', () => {
    vi.useFakeTimers()
    home.dir = mkdtempSync(join(tmpdir(), 'lumen-teach-lazy-'))
    const dir = join(home.dir, '.ai-overlay', 'skills', 'quill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({
        id: 'quill',
        name: 'Quill',
        version: '1.0.0',
        match: { process: ['quill.exe'] },
        uiaQuality: 'good'
      })
    )
    const load = vi.spyOn(SkillRegistry.prototype, 'load')
    installTeach()
    expect(load).not.toHaveBeenCalled()
    expect(skillRegistry()?.matchApp({ process: 'quill.exe', title: 'x' })?.id).toBe('quill')
    expect(load).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    skillRegistry()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
