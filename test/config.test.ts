import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadConfig,
  saveConfig,
  configPath,
  backupPath,
  setConfigDir,
  invalidateConfig,
  lastConfigWarning,
  DEFAULT_CONFIG
} from '../src/main/config'
import {
  DEFAULT_CONFIG_V1,
  configPatchSchema,
  configV2Schema,
  migrateV1toV2
} from '../src/shared/config'

let dir: string

const writeRaw = (data: unknown): void =>
  writeFileSync(configPath(), typeof data === 'string' ? data : JSON.stringify(data))

const readDisk = (): Record<string, unknown> => JSON.parse(readFileSync(configPath(), 'utf8'))

const FULL_V1 = {
  version: 1,
  theme: 'custom',
  themeCustom: {
    accent: '#112233',
    background: '#000000',
    foreground: '#ffffff',
    opacity: 0.8,
    blur: 10
  },
  models: { planning: 'gpt-5', execution: 'claude-sonnet-4-6', verification: 'gpt-5-nano' },
  hotkey: 'Alt+B',
  hudAutoCloseMs: 3000,
  answerAutoCloseMs: 0,
  wakeWord: { enabled: true, phrase: 'hey computer' },
  statusBubble: { enabled: false },
  voiceVocab: 'Kubernetes, Exness',
  historyEnabled: false,
  explainBeforeDo: false,
  uiScale: 1.4,
  handsFreeMode: true,
  cancelVoice: { enabled: true, phrases: 'stop' },
  tts: { enabled: true, voice: 'nova' },
  showConfidence: true,
  dwellClick: { enabled: true, dwellMs: 900, cooldownMs: 500 },
  vad: { silenceMs: 1200, maxWaitMs: 6000, speechThreshold: 0.06, maxRecordMs: 30000 },
  guideAutoDismissOnMove: true,
  historyExchanges: 8,
  someFutureKey: { a: 1 }
}

describe('config', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-overlay-test-'))
    setConfigDir(dir)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    setConfigDir(null)
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('uses the injected directory', () => {
    expect(configPath()).toBe(join(dir, 'config.json'))
  })

  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig()
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(cfg.version).toBe(2)
    expect(lastConfigWarning()).toBeNull()
  })

  it('default v2 config is valid', () => {
    expect(configV2Schema.safeParse(DEFAULT_CONFIG).success).toBe(true)
  })

  it('migrates the default v1 config to the v2 defaults', () => {
    writeRaw(DEFAULT_CONFIG_V1)
    expect(loadConfig()).toEqual(DEFAULT_CONFIG)
    expect(lastConfigWarning()).toBeNull()
  })

  it('migrates a v1 config with every field set', () => {
    writeRaw(FULL_V1)
    const cfg = loadConfig()
    expect(lastConfigWarning()).toBeNull()
    expect(cfg.version).toBe(2)
    expect(cfg.theme).toBe('custom')
    expect(cfg.themeCustom).toEqual(FULL_V1.themeCustom)
    expect(cfg.models).toEqual({
      provider: 'auto',
      planning: 'gpt-5',
      main: 'claude-sonnet-4-6',
      verify: 'gpt-5-nano'
    })
    expect(cfg.hotkey).toBe('Alt+B')
    expect(cfg.hudAutoCloseMs).toBe(3000)
    expect(cfg.answerAutoCloseMs).toBe(0)
    expect(cfg.wakeWord).toEqual({ enabled: true, phrase: 'hey computer', sensitivity: 0.5 })
    expect(cfg.statusBubble.enabled).toBe(false)
    expect(cfg.voiceVocab).toBe('Kubernetes, Exness')
    expect(cfg.historyEnabled).toBe(false)
    expect(cfg.historyExchanges).toBe(8)
    expect(cfg.explainBeforeDo).toBe(false)
    expect(cfg.handsFreeMode).toBe(true)
    expect(cfg.cancelVoice).toEqual({ enabled: true, phrases: 'stop' })
    expect(cfg.showConfidence).toBe(true)
    expect(cfg.dwellClick).toEqual(FULL_V1.dwellClick)
    expect(cfg.vad).toEqual(FULL_V1.vad)
    expect(cfg.guideAutoDismissOnMove).toBe(true)
    expect(cfg.a11y.uiScale).toBe(1.4)
    expect(cfg.voice.tts).toBe('cloud')
    expect(cfg.voice.ttsVoice).toBe('nova')
    expect(cfg.legacy).toEqual({ someFutureKey: { a: 1 } })
    expect(cfg).not.toHaveProperty('uiScale')
    expect(cfg).not.toHaveProperty('tts')
  })

  it('migrates a partial v1 config, filling defaults', () => {
    writeRaw({
      version: 1,
      theme: 'forest',
      models: { execution: 'gpt-5' },
      tts: { enabled: false },
      dwellClick: { enabled: true }
    })
    const cfg = loadConfig()
    expect(cfg.theme).toBe('forest')
    expect(cfg.models).toEqual({ provider: 'auto', main: 'gpt-5' })
    expect(cfg.voice.tts).toBe('off')
    expect(cfg.voice.ttsVoice).toBe(DEFAULT_CONFIG.voice.ttsVoice)
    expect(cfg.dwellClick).toEqual({ ...DEFAULT_CONFIG.dwellClick, enabled: true })
    expect(cfg.hotkey).toBe(DEFAULT_CONFIG.hotkey)
    expect(cfg.a11y).toEqual(DEFAULT_CONFIG.a11y)
    expect(cfg.legacy).toBeUndefined()
  })

  it('treats a version-less file as v1', () => {
    writeRaw({ theme: 'forest', uiScale: 1.2 })
    const cfg = loadConfig()
    expect(cfg.theme).toBe('forest')
    expect(cfg.a11y.uiScale).toBe(1.2)
    expect(cfg.hudAutoCloseMs).toBe(DEFAULT_CONFIG.hudAutoCloseMs)
  })

  it('migrateV1toV2 is pure and maps tts enabled to cloud', () => {
    const src = { version: 1, tts: { enabled: true, voice: 'echo' } }
    expect(migrateV1toV2(src)).toEqual({
      version: 2,
      models: { provider: 'auto' },
      voice: { tts: 'cloud', ttsVoice: 'echo' }
    })
    expect(src).toEqual({ version: 1, tts: { enabled: true, voice: 'echo' } })
  })

  it('does not write on load, backs up v1 before the first v2 write', () => {
    writeRaw(FULL_V1)
    const before = readFileSync(configPath(), 'utf8')
    loadConfig()
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
    expect(existsSync(backupPath())).toBe(false)

    saveConfig({ theme: 'ocean' })
    expect(readFileSync(backupPath(), 'utf8')).toBe(before)
    const disk = readDisk()
    expect(disk.version).toBe(2)
    expect(disk.theme).toBe('ocean')
    expect((disk.a11y as { uiScale: number }).uiScale).toBe(1.4)

    // a later save must not overwrite the original backup
    saveConfig({ theme: 'forest' })
    expect(readFileSync(backupPath(), 'utf8')).toBe(before)
  })

  it('does not create a v1 backup for a fresh install', () => {
    saveConfig({ theme: 'ocean' })
    expect(existsSync(backupPath())).toBe(false)
  })

  it('falls back to defaults on malformed JSON and keeps a copy', () => {
    writeRaw('{ this is not json')
    const cfg = loadConfig()
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(lastConfigWarning()).toMatch(/unreadable/)
    const copies = readdirSync(dir).filter((f) => /^config\.invalid\.\d+\.json$/.test(f))
    expect(copies).toHaveLength(1)
    expect(readFileSync(join(dir, copies[0]), 'utf8')).toBe('{ this is not json')
  })

  it('resets only invalid sections and keeps a copy of the bad file', () => {
    writeRaw({
      ...FULL_V1,
      hotkey: 'x; calc.exe',
      dwellClick: { enabled: true, dwellMs: -5, cooldownMs: 1 }
    })
    const cfg = loadConfig()
    expect(cfg.hotkey).toBe(DEFAULT_CONFIG.hotkey)
    expect(cfg.dwellClick).toEqual(DEFAULT_CONFIG.dwellClick)
    expect(cfg.theme).toBe('custom')
    expect(cfg.a11y.uiScale).toBe(1.4)
    expect(lastConfigWarning()).toMatch(/hotkey/)
    expect(readdirSync(dir).some((f) => f.startsWith('config.invalid.'))).toBe(true)
  })

  it('falls back to defaults for a non-object file', () => {
    writeRaw('[1,2]')
    expect(loadConfig()).toEqual(DEFAULT_CONFIG)
    expect(lastConfigWarning()).toMatch(/not an object/)
  })

  it('round-trips a save through disk', () => {
    const saved = saveConfig({
      theme: 'ocean',
      hotkey: 'F9',
      a11y: { uiScale: 1.25 },
      voice: { tts: 'cloud' }
    })
    invalidateConfig()
    const cfg = loadConfig()
    expect(cfg).toEqual(saved)
    expect(cfg.a11y).toEqual({ ...DEFAULT_CONFIG.a11y, uiScale: 1.25 })
    expect(cfg.voice.tts).toBe('cloud')
    expect(cfg.voice.ttsVoice).toBe(DEFAULT_CONFIG.voice.ttsVoice)
  })

  it('saveConfig merges nested sections one level deep', () => {
    saveConfig({ theme: 'ocean', hotkey: 'F9', models: { main: 'gpt-5' } })
    saveConfig({ theme: 'forest', models: { verify: 'gpt-5-nano' } })
    const cfg = loadConfig()
    expect(cfg.theme).toBe('forest')
    expect(cfg.hotkey).toBe('F9')
    expect(cfg.models).toEqual({ provider: 'auto', main: 'gpt-5', verify: 'gpt-5-nano' })
  })

  it('saveConfig rejects an invalid result and leaves the file untouched', () => {
    saveConfig({ theme: 'ocean' })
    const before = readFileSync(configPath(), 'utf8')
    expect(() => saveConfig({ hotkey: 'nope' } as never)).toThrow()
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
    expect(loadConfig().hotkey).toBe(DEFAULT_CONFIG.hotkey)
  })

  it('preserves legacy keys across saves', () => {
    writeRaw(FULL_V1)
    saveConfig({ theme: 'ocean' })
    invalidateConfig()
    expect(loadConfig().legacy).toEqual({ someFutureKey: { a: 1 } })
  })

  it('invalidateConfig rereads the file', () => {
    expect(loadConfig().theme).toBe('dark')
    writeRaw({ ...DEFAULT_CONFIG, theme: 'midnight' })
    expect(loadConfig().theme).toBe('dark')
    invalidateConfig()
    expect(loadConfig().theme).toBe('midnight')
  })

  it('fills wake sensitivity and mic device for a v2 file written before they existed', () => {
    const old = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
    delete old.wakeWord.sensitivity
    delete old.voice.micDeviceId
    old.wakeWord.phrase = 'hey computer'
    writeRaw(old)
    const cfg = loadConfig()
    expect(lastConfigWarning()).toBeNull()
    expect(cfg.wakeWord).toEqual({ enabled: false, phrase: 'hey computer', sensitivity: 0.5 })
    expect(cfg.voice.micDeviceId).toBe('')
  })

  it('a partial wakeWord / voice patch keeps the saved sensitivity and mic', () => {
    saveConfig({ wakeWord: { ...DEFAULT_CONFIG.wakeWord, sensitivity: 0.8 } })
    saveConfig({ voice: { ...DEFAULT_CONFIG.voice, micDeviceId: 'abc' } })
    const patch = configPatchSchema.parse({ wakeWord: { enabled: true }, voice: { ttsRate: 1.2 } })
    expect(patch).toEqual({ wakeWord: { enabled: true }, voice: { ttsRate: 1.2 } })
    saveConfig(patch as never)
    const cfg = loadConfig()
    expect(cfg.wakeWord.sensitivity).toBe(0.8)
    expect(cfg.voice.micDeviceId).toBe('abc')
  })

  it('patch schema bounds wake sensitivity and mic device', () => {
    expect(configPatchSchema.safeParse({ wakeWord: { sensitivity: 0.3 } }).success).toBe(true)
    expect(configPatchSchema.safeParse({ wakeWord: { sensitivity: 1.5 } }).success).toBe(false)
    expect(configPatchSchema.safeParse({ wakeWord: { sensitivity: -0.1 } }).success).toBe(false)
    expect(configPatchSchema.safeParse({ voice: { micDeviceId: 'x'.repeat(201) } }).success).toBe(
      false
    )
  })
})

describe('configPatchSchema defaults', () => {
  it('does not fill defaults into fields the patch leaves out', () => {
    expect(configPatchSchema.parse({ a11y: { uiScale: 1.5 } })).toEqual({ a11y: { uiScale: 1.5 } })
    expect(configPatchSchema.parse({ wakeWord: { enabled: true } })).toEqual({
      wakeWord: { enabled: true }
    })
  })
})
