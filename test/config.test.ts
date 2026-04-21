import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock os.homedir to point at a temp dir so we don't touch the real ~/.ai-overlay
let tempHome: string

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => tempHome }
})

describe('config', () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'ai-overlay-test-'))
    vi.resetModules()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('returns defaults when no config file exists', async () => {
    const { loadConfig, DEFAULT_CONFIG } = await import('../src/main/config')
    const cfg = loadConfig()
    expect(cfg.theme).toBe(DEFAULT_CONFIG.theme)
    expect(cfg.models).toEqual({})
  })

  it('saveConfig writes JSON to ~/.ai-overlay/config.json', async () => {
    const { saveConfig, configPath } = await import('../src/main/config')
    saveConfig({ theme: 'ocean' })
    expect(existsSync(configPath())).toBe(true)
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'))
    expect(raw.theme).toBe('ocean')
  })

  it('merges partial config with defaults on load', async () => {
    const { configPath, loadConfig, DEFAULT_CONFIG } = await import('../src/main/config')
    const dir = join(tempHome, '.ai-overlay')
    require('fs').mkdirSync(dir, { recursive: true })
    writeFileSync(configPath(), JSON.stringify({ theme: 'forest' }))
    const cfg = loadConfig()
    expect(cfg.theme).toBe('forest')
    expect(cfg.hotkey).toBe(DEFAULT_CONFIG.hotkey)
    expect(cfg.hudAutoCloseMs).toBe(DEFAULT_CONFIG.hudAutoCloseMs)
  })

  it('returns defaults on malformed JSON', async () => {
    const { configPath, loadConfig, DEFAULT_CONFIG } = await import('../src/main/config')
    const dir = join(tempHome, '.ai-overlay')
    require('fs').mkdirSync(dir, { recursive: true })
    writeFileSync(configPath(), '{ this is not json')
    const cfg = loadConfig()
    expect(cfg.theme).toBe(DEFAULT_CONFIG.theme)
  })

  it('saveConfig merges with existing values', async () => {
    const { saveConfig, loadConfig } = await import('../src/main/config')
    saveConfig({ theme: 'ocean', hotkey: 'F9' })
    saveConfig({ theme: 'forest' })
    const cfg = loadConfig()
    expect(cfg.theme).toBe('forest')
    expect(cfg.hotkey).toBe('F9')
  })
})
