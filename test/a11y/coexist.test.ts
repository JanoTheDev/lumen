import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import {
  AT_HOTKEYS,
  addressedToLumen,
  coexistNotice,
  shouldYield,
  voiceControlName,
  wakeConfig,
  wakeSuspended,
  type CoexistConfig
} from '../../src/main/a11y/coexist'
import { A11yCommands, LOCAL_HANDLED } from '../../src/main/a11y/dispatch'
import { onAtStateChange, setAtState, type AtState } from '../../src/main/a11y/at-state'
import { planShortcuts } from '../../src/main/a11y/shortcuts'
import { IDLE_CONTEXT, parseCommand, type Command } from '../../src/main/a11y/voice-commands'
import { DEFAULT_CONFIG_V2 } from '../../src/shared/config'
import { fakeA11yIo } from '../helpers/fake-a11y-io'

const cfg = (over: Partial<CoexistConfig['a11y']['coexist']> = {}, wake = true): CoexistConfig => ({
  wakeWord: { enabled: wake },
  a11y: { coexist: { yieldToVoiceControl: true, wakeWithDragon: false, ...over } }
})
const at = (
  voiceControl: string[] = [],
  screenReader: AtState['screenReader'] = null
): AtState => ({
  screenReader,
  voiceControl
})

describe('coexistence with voice control (T20)', () => {
  it('names the app to step aside for, unless turned off', () => {
    expect(voiceControlName(at(['voice-access']), cfg())).toBe('Voice Access')
    expect(voiceControlName(at(['dragon']), cfg())).toBe('Dragon')
    expect(voiceControlName(at([]), cfg())).toBeNull()
    expect(voiceControlName(at(['voice-access']), cfg({ yieldToVoiceControl: false }))).toBeNull()
  })

  it('knows when the user is talking to Lumen', () => {
    expect(addressedToLumen('Lumen, show numbers')).toBe(true)
    expect(addressedToLumen('hey Lumen scroll down')).toBe(true)
    expect(addressedToLumen('show numbers')).toBe(false)
    expect(addressedToLumen('luminous')).toBe(false)
  })

  it('yields shared commands, never Lumen-only ones or its own overlays', () => {
    const cmd = (u: string, ctx = IDLE_CONTEXT): Command => parseCommand(u, ctx)!
    const who = 'Voice Access'
    expect(shouldYield(cmd('show numbers'), 'show numbers', IDLE_CONTEXT, who)).toBe(true)
    expect(shouldYield(cmd('scroll down'), 'scroll down', IDLE_CONTEXT, who)).toBe(true)
    expect(shouldYield(cmd('lumen numbers'), 'Lumen numbers', IDLE_CONTEXT, who)).toBe(false)
    expect(shouldYield(cmd('describe screen'), 'describe screen', IDLE_CONTEXT, who)).toBe(false)
    expect(shouldYield(cmd('what can I say'), 'what can I say', IDLE_CONTEXT, who)).toBe(false)
    const marks = { ...IDLE_CONTEXT, marksShown: true }
    expect(shouldYield(cmd('click 5', marks), 'click 5', marks, who)).toBe(false)
    expect(shouldYield(cmd('scroll down'), 'scroll down', IDLE_CONTEXT, null)).toBe(false)
  })

  it('the dispatcher leaves "show numbers" alone while Voice Access runs and says why', async () => {
    const f = fakeA11yIo({ voiceControl: 'Voice Access' })
    const a = new A11yCommands(f.io)
    expect(a.tryHandle('show numbers')).toEqual({ response: LOCAL_HANDLED })
    await f.settle()
    expect(f.calls.snapshots).toEqual([])
    expect(f.calls.feedback[0].text).toMatch(/^Voice Access handles that/)
    expect(a.tryHandle('Lumen, show numbers')).toEqual({ response: LOCAL_HANDLED })
    await f.settle()
    expect(f.calls.snapshots).toEqual(['foreground'])
  })

  it('suspends the wake word while Dragon runs, unless asked to keep it', () => {
    expect(wakeSuspended(at(['dragon']), cfg())).toBe(true)
    expect(wakeSuspended(at(['voice-access']), cfg())).toBe(false)
    expect(wakeSuspended(at(['dragon']), cfg({ wakeWithDragon: true }))).toBe(false)
    expect(wakeSuspended(at(['dragon']), cfg({}, false))).toBe(false)
    const c = { ...cfg(), other: 1 }
    expect(wakeConfig(c, at(['dragon'])).wakeWord.enabled).toBe(false)
    expect(wakeConfig(c, at(['dragon'])).other).toBe(1)
    expect(wakeConfig(c, at())).toBe(c)
  })

  it('tells the user once when voice control starts', () => {
    expect(coexistNotice(at(), at(['voice-access']), cfg())).toMatch(/Voice Access is running/)
    expect(coexistNotice(at(['voice-access']), at(['voice-access']), cfg())).toBeNull()
    expect(coexistNotice(at(), at(['dragon']), cfg())).toMatch(/wake word is off/)
    expect(coexistNotice(at(['dragon']), at(), cfg())).toBeNull()
  })

  it('reports assistive-tech changes to listeners', () => {
    const seen: string[][] = []
    const off = onAtStateChange((next, prev) =>
      seen.push([...prev.voiceControl, '→', ...next.voiceControl])
    )
    setAtState({ screenReader: null, voiceControl: ['dragon'] })
    setAtState({ screenReader: null, voiceControl: ['dragon'] })
    setAtState({ screenReader: null, voiceControl: [] })
    off()
    expect(seen).toEqual([
      ['→', 'dragon'],
      ['dragon', '→']
    ])
  })

  it('a11y shortcuts may not take assistive-tech keys', () => {
    expect(AT_HOTKEYS.get('alt+shift+b')).toMatch(/Voice Access/)
    const c = {
      ...DEFAULT_CONFIG_V2,
      a11y: {
        ...DEFAULT_CONFIG_V2.a11y,
        shortcuts: { ...DEFAULT_CONFIG_V2.a11y.shortcuts, numbers: 'Alt+Shift+B' }
      }
    }
    const { status } = planShortcuts(c, { dwellOn: false, lessonRunning: false })
    expect(status.find((s) => s.action === 'numbers')).toMatchObject({
      state: 'conflict',
      with: 'Voice Access (microphone on/off)'
    })
  })
})
