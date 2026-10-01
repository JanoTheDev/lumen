import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from '../helpers/fixtures'
import { redact, rotate } from '../../src/main/diagnostics/log-file'
import { rateLimiter } from '../../src/main/diagnostics/crash'
import { redactConfig } from '../../src/main/diagnostics/export'

describe('diagnostics', () => {
  let tmp: ReturnType<typeof tempDir> | null = null
  afterEach(() => {
    tmp?.cleanup()
    tmp = null
  })

  it('redacts API-key-shaped strings', () => {
    const text = [
      'key ' + ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz'].join('-'),
      'openai ' + ['sk', 'proj', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join('-'),
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      '{"apiKey":"abcdef0123456789"}'
    ].join('\n')
    const out = redact(text)
    expect(out).not.toMatch(/abcdefghijklmnop|ABCDEFGHIJKLMNOP|abcdef0123456789/)
    expect(out).toContain('sk-ant-[redacted]')
    expect(redact('hotkey Ctrl+Shift+Space')).toBe('hotkey Ctrl+Shift+Space')
  })

  it('rotates main.log keeping 5 files', () => {
    tmp = tempDir()
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(tmp.dir, 'main.log'), `run ${i}`)
      rotate(tmp.dir)
    }
    expect(existsSync(join(tmp.dir, 'main.log'))).toBe(false)
    expect(readFileSync(join(tmp.dir, 'main.1.log'), 'utf8')).toBe('run 6')
    expect(readFileSync(join(tmp.dir, 'main.4.log'), 'utf8')).toBe('run 3')
    expect(existsSync(join(tmp.dir, 'main.5.log'))).toBe(false)
  })

  it('drops keys, word lists and phrases from the exported config', () => {
    const cfg = {
      hotkey: 'Ctrl+Shift+Space',
      wakeWord: { enabled: true, phrase: 'hey lumen' },
      dictation: { dictionary: ['Jano', 'Lumen'] },
      models: {
        provider: 'auto',
        note: ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuv'].join('-')
      },
      legacy: { apiKey: 'abc123456789', a11y: { shortcuts: { repeat: 'Ctrl+Shift+F3' } } }
    }
    const out = JSON.stringify(redactConfig(cfg))
    expect(out).toContain('Ctrl+Shift+Space')
    expect(out).toContain('Ctrl+Shift+F3')
    expect(out).not.toMatch(/hey lumen|Jano|abc123456789|abcdefghijklmnop/)
  })

  it('limits window reloads to 3 a minute', () => {
    let t = 0
    const may = rateLimiter(3, 60_000, () => t)
    expect([may(), may(), may(), may()]).toEqual([true, true, true, false])
    t = 60_001
    expect(may()).toBe(true)
  })
})
