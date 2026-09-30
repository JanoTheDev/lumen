import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { makeConfig, tempDir, tinyJpeg } from './fixtures'

describe('fixtures helper', () => {
  it('makeConfig deep-merges overrides into a valid config', () => {
    const cfg = makeConfig({ hotkey: 'Ctrl+Alt+K', wakeWord: { enabled: true } })
    expect(cfg.hotkey).toBe('Ctrl+Alt+K')
    expect(cfg.wakeWord.enabled).toBe(true)
    expect(cfg.wakeWord.phrase).toBeTruthy()
  })

  it('tinyJpeg encodes the requested size in the SOF0 header', () => {
    const buf = Buffer.from(tinyJpeg(1280, 800), 'base64')
    const sof = buf.indexOf(Buffer.from([0xff, 0xc0]))
    expect(buf.readUInt16BE(sof + 5)).toBe(800)
    expect(buf.readUInt16BE(sof + 7)).toBe(1280)
  })

  it('tempDir cleans up after itself', () => {
    const { dir, cleanup } = tempDir()
    expect(existsSync(dir)).toBe(true)
    cleanup()
    expect(existsSync(dir)).toBe(false)
  })
})
