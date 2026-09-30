import { describe, it, expect } from 'vitest'
import {
  HOTKEY_RE,
  configPatchSchema,
  configV1Schema,
  configV2Schema,
  DEFAULT_CONFIG_V1
} from '../src/shared/config'
import {
  actionsSchema,
  audioSchema,
  guideIdSchema,
  overlayHeightSchema,
  parsePayload,
  promptSchema,
  MAX_AUDIO_BYTES
} from '../src/shared/ipc'
import { DEFAULT_CONFIG } from '../src/main/config'

describe('hotkey validation', () => {
  it.each(['Ctrl+Shift+Space', 'Alt+B', 'F9', 'Ctrl+Alt+F12', 'Super+/', 'Shift+ArrowUp'])(
    'accepts %s',
    (k) => {
      expect(HOTKEY_RE.test(k)).toBe(true)
    }
  )
  it.each(['', 'B', 'Ctrl+', 'ctrl+a; rm -rf', 'Ctrl+Shift+Space\n', 'Alt+B+"', 'F13'])(
    'rejects %j',
    (k) => {
      expect(HOTKEY_RE.test(k)).toBe(false)
    }
  )
})

describe('config patch', () => {
  it('default config is valid', () => {
    expect(configV2Schema.safeParse(DEFAULT_CONFIG).success).toBe(true)
    expect(configV1Schema.safeParse(DEFAULT_CONFIG_V1).success).toBe(true)
  })
  it('accepts partial nested patches', () => {
    expect(configPatchSchema.safeParse({ wakeWord: { phrase: 'hey computer' } }).success).toBe(true)
    expect(
      configPatchSchema.safeParse({
        a11y: { uiScale: 1.2 },
        voice: { tts: 'cloud' },
        models: { main: 'gpt-5' }
      }).success
    ).toBe(true)
  })
  it.each([
    { hotkey: 'x; calc.exe' },
    { unknownKey: 1 },
    { models: { planning: 'rm -rf /' } },
    { uiScale: 1 },
    { tts: { enabled: true } },
    { a11y: { uiScale: 'big' } },
    { voice: { tts: 'loud' } },
    { models: { execution: 'gpt-5' } },
    { dwellClick: { dwellMs: -5 } },
    {
      themeCustom: {
        accent: 'red',
        background: '#000000',
        foreground: '#ffffff',
        opacity: 1,
        blur: 0
      }
    },
    null,
    'string'
  ])('rejects %j', (patch) => {
    expect(configPatchSchema.safeParse(patch).success).toBe(false)
  })
})

describe('ipc payloads', () => {
  it('prompt must be a bounded non-empty string', () => {
    expect(() => parsePayload('query', promptSchema, '')).toThrow(/E_INVALID|invalid payload/)
    expect(() => parsePayload('query', promptSchema, 'x'.repeat(5000))).toThrow()
    expect(() => parsePayload('query', promptSchema, { a: 1 })).toThrow()
    expect(parsePayload('query', promptSchema, ' hi ')).toBe('hi')
  })
  it('guide ids cannot escape the guides dir', () => {
    expect(guideIdSchema.safeParse('../config').success).toBe(false)
    expect(guideIdSchema.safeParse('C:\\x').success).toBe(false)
    expect(guideIdSchema.safeParse('compose-email-abc12').success).toBe(true)
  })
  it('clamps overlay height', () => {
    expect(parsePayload('r', overlayHeightSchema, 5000)).toBe(800)
    expect(parsePayload('r', overlayHeightSchema, 10)).toBe(60)
    expect(overlayHeightSchema.safeParse(NaN).success).toBe(false)
    expect(overlayHeightSchema.safeParse(Infinity).success).toBe(false)
  })
  it('caps audio size', () => {
    expect(audioSchema.safeParse(new ArrayBuffer(10)).success).toBe(true)
    expect(audioSchema.safeParse(new ArrayBuffer(MAX_AUDIO_BYTES + 1)).success).toBe(false)
    expect(audioSchema.safeParse('abc').success).toBe(false)
  })
  it('validates actions', () => {
    expect(actionsSchema.safeParse([{ type: 'click', x: 1, y: 2 }]).success).toBe(true)
    expect(actionsSchema.safeParse([{ type: 'run_shell', cmd: 'calc' }]).success).toBe(false)
    expect(actionsSchema.safeParse([{ type: 'click', x: 'a' }]).success).toBe(false)
  })
})
