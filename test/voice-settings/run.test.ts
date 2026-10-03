import { describe, expect, it } from 'vitest'
import {
  configPatchSchema,
  configV2Schema,
  DEFAULT_CONFIG_V2,
  withV2Defaults
} from '@shared/config'
import type { AppConfig } from '../../src/main/config'
import { parseSettingsCommand } from '../../src/main/voice-settings/grammar'
import {
  chooseVoice,
  patchFor,
  runSettingsCommand,
  shortVoiceName,
  type SettingsPorts,
  type VoiceInfo
} from '../../src/main/voice-settings/run'

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const merge = (a: unknown, b: unknown): unknown => {
  if (!isObj(a) || !isObj(b)) return b
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v)
  return out
}

const VOICES: VoiceInfo[] = [
  { name: 'Microsoft David', lang: 'en-US', gender: 'male' },
  { name: 'Microsoft Zira', lang: 'en-US', gender: 'female' },
  { name: 'Microsoft Helena', lang: 'es-ES', gender: 'female' }
]

interface Fake {
  say: (text: string) => Promise<string>
  patches: Record<string, unknown>[]
  confirms: string[]
  opened: string[]
  cfg: () => AppConfig
}

function fake(
  start: Partial<AppConfig> = {},
  opts: { confirm?: boolean; hear?: boolean } = {}
): Fake {
  let cfg = configV2Schema.parse(merge(structuredClone(DEFAULT_CONFIG_V2), start)) as AppConfig
  const patches: Record<string, unknown>[] = []
  const confirms: string[] = []
  const opened: string[] = []
  const ports: SettingsPorts = {
    config: () => cfg,
    patch: async (p) => {
      // The same checks as patchConfig + saveConfig.
      const parsed = configPatchSchema.safeParse(p)
      if (!parsed.success) throw new Error(`bad patch ${JSON.stringify(p)}`)
      patches.push(p)
      cfg = configV2Schema.parse(withV2Defaults(merge(cfg, parsed.data) as Record<string, unknown>))
      return cfg
    },
    confirm: async (c) => {
      confirms.push(c.summary)
      return opts.confirm ?? true
    },
    openPanel: (r) => opened.push(r),
    faceInstalled: () => true,
    canHear: () => opts.hear ?? true,
    voices: async () => ({ engine: 'windows', list: VOICES, current: VOICES[0] }),
    update: null
  }
  const say = (text: string): Promise<string> => {
    const cmd = parseSettingsCommand(text)
    if (!cmd) throw new Error(`no command for ${text}`)
    return runSettingsCommand(cmd, ports)
  }
  return { say, patches, confirms, opened, cfg: () => cfg }
}

describe('patch shapes', () => {
  it('top-level and one-level keys stay partial; deeper objects keep their siblings', () => {
    const cfg = DEFAULT_CONFIG_V2
    expect(patchFor(cfg, ['theme'], 'light')).toEqual({ theme: 'light' })
    expect(patchFor(cfg, ['voice', 'tts'], 'windows')).toEqual({ voice: { tts: 'windows' } })
    expect(patchFor(cfg, ['a11y', 'switch', 'enabled'], true)).toEqual({
      a11y: { switch: { ...cfg.a11y.switch, enabled: true } }
    })
    expect(patchFor(cfg, ['a11y', 'face', 'enabled'], true)).toEqual({
      a11y: { face: { ...cfg.a11y.face, enabled: true } }
    })
  })

  it('every change is a valid patch that leaves the rest alone', async () => {
    const f = fake({
      voice: { ...DEFAULT_CONFIG_V2.voice, tts: 'off', ttsRate: 1.5, language: 'en' }
    })
    expect(await f.say('read answers aloud')).toBe(
      'Spoken replies on. Say “turn off spoken replies” to undo.'
    )
    expect(f.patches.at(-1)).toEqual({ voice: { tts: 'windows' } })
    expect(f.cfg().voice.ttsRate).toBe(1.5)

    await f.say('turn on switch access')
    expect(f.cfg().a11y.switch).toEqual({ ...DEFAULT_CONFIG_V2.a11y.switch, enabled: true })
    expect(f.cfg().a11y.uiScale).toBe(1)

    await f.say('turn on face gestures')
    expect(f.cfg().a11y.face.enabled).toBe(true)
    expect(f.cfg().a11y.face.bindings).toEqual(DEFAULT_CONFIG_V2.a11y.face.bindings)

    await f.say('turn on dwell clicking')
    expect(f.patches.at(-1)).toEqual({ dwellClick: { enabled: true } })
    expect(f.cfg().dwellClick.dwellMs).toBe(DEFAULT_CONFIG_V2.dwellClick.dwellMs)

    await f.say('turn on pointing')
    expect(f.patches.at(-1)).toEqual({ helpers: { deictic: true } })
    expect(f.cfg().helpers.undo).toBe(true)
  })

  it('keeps the cloud voice when it was chosen', async () => {
    const f = fake({ voice: { ...DEFAULT_CONFIG_V2.voice, tts: 'cloud' } })
    expect(await f.say('talk to me')).toBe('Spoken replies is already on.')
    await f.say('mute your voice')
    expect(f.cfg().voice.tts).toBe('off')
    await f.say('talk to me')
    expect(f.cfg().voice.tts).toBe('windows')
  })
})

describe('numbers', () => {
  it('steps, clamps and resets', async () => {
    const f = fake()
    expect(await f.say('make your text bigger')).toBe(
      'Text size 125 percent. Say “make your text smaller” to go back.'
    )
    await f.say('set your text size to 300 percent')
    expect(f.cfg().a11y.uiScale).toBe(3)
    expect(await f.say('make your text bigger')).toBe(
      'Text size is already at the most: 300 percent.'
    )
    await f.say('reset your text size')
    expect(f.cfg().a11y.uiScale).toBe(1)
    await f.say('speak slower')
    expect(f.cfg().voice.ttsRate).toBe(0.75)
  })

  it('wake sensitivity starts from the default when unset', async () => {
    const f = fake({ wakeWord: { enabled: true, phrase: 'hey lumen' } })
    await f.say('make the wake word more sensitive')
    expect(f.cfg().wakeWord.sensitivity).toBe(0.6)
  })
})

describe('enums and guards', () => {
  it('language: refuses one it cannot hear', async () => {
    const f = fake({}, { hear: false })
    expect(await f.say('speak Italian')).toMatch(/needs an OpenAI key/)
    expect(f.patches).toEqual([])
    const g = fake()
    expect(await g.say('speak Spanish')).toBe(
      'I’ll speak Spanish now. Say “speak English” to go back.'
    )
    expect(g.cfg().voice.language).toBe('es')
    expect(await g.say('habla inglés')).toBe(
      'I’ll speak English now. Say “speak Spanish” to go back.'
    )
  })

  it('theme undo sentence names Lumen', async () => {
    const f = fake()
    expect(await f.say('turn on light mode in Lumen')).toBe(
      'Theme: light. Say “set your theme to dark” to go back.'
    )
    expect(parseSettingsCommand('set your theme to dark')).not.toBeNull()
  })

  it('weakening a guard asks first', async () => {
    const f = fake({}, { confirm: false })
    expect(await f.say('stop asking for permission')).toBe(
      'Okay, asking before actions stays the same.'
    )
    expect(f.confirms).toHaveLength(1)
    expect(f.cfg().agent.confirm).toBe('risky')
    const g = fake({ models: { provider: 'auto', localOnly: true } }, { confirm: false })
    expect(await g.say('turn off local only')).toBe('Okay, local only stays on.')
    expect(g.cfg().models.localOnly).toBe(true)
    const h = fake()
    await h.say('turn on local only')
    expect(h.confirms).toEqual([])
    expect(h.cfg().models.localOnly).toBe(true)
  })

  it('reads values back', async () => {
    const f = fake()
    expect(await f.say('is the wake word on')).toBe('Wake word is off.')
    expect(await f.say("what's your text size")).toBe('Text size is 100 percent.')
    expect(await f.say('what language are you speaking')).toBe('I’m speaking English.')
  })
})

describe('pages and voices', () => {
  it('opens panel routes', async () => {
    const f = fake()
    expect(await f.say('open voice settings')).toBe('Opening Voice settings.')
    await f.say('start setup again')
    expect(f.opened).toEqual(['settings/voice', 'onboarding'])
  })

  it('chooses voices by name, gender and next', async () => {
    expect(chooseVoice('zira', VOICES, VOICES[0], 'en')?.name).toBe('Microsoft Zira')
    expect(chooseVoice('female', VOICES, VOICES[0], 'en')?.name).toBe('Microsoft Zira')
    expect(chooseVoice('female', VOICES, null, 'es')?.name).toBe('Microsoft Helena')
    expect(chooseVoice('next', VOICES, VOICES[1], 'en')?.name).toBe('Microsoft David')
    expect(chooseVoice('bob', VOICES, null, 'en')).toBeNull()
    expect(shortVoiceName('Microsoft Zira Desktop - English (United States)')).toBe('Zira')
    const f = fake()
    expect(await f.say('use the voice Zira')).toMatch(/^Voice: Zira\./)
    expect(f.patches.at(-1)).toEqual({ voice: { ttsVoice: 'Microsoft Zira' } })
    expect(await f.say('use the voice bob')).toBe(
      'I don’t have a voice called bob. I have David, Zira and Helena.'
    )
  })
})
