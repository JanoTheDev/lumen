import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  installAudit,
  lastTaskSummary,
  listAudit,
  setAuditStoreTypedText,
  summarizeAction,
  uninstallAudit,
  writeAudit,
  type AuditEntry
} from '../../src/main/audit/log'
import { tempDir } from '../helpers/fixtures'

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  t: '2026-10-01T10:00:00.000Z',
  task: 't_1',
  origin: 'agent',
  action: { type: 'click' },
  risk: 'low',
  decision: 'auto',
  result: 'ok',
  ms: 5,
  ...over
})

describe('audit log', () => {
  let tmp: ReturnType<typeof tempDir>

  beforeEach(() => {
    tmp = tempDir()
  })
  afterEach(() => {
    uninstallAudit()
    tmp.cleanup()
  })

  it('appends one NDJSON line per entry to the day file', () => {
    installAudit(tmp.dir, 30, Date.parse('2026-10-01T12:00:00Z'))
    writeAudit(entry())
    writeAudit(entry({ task: 't_2', result: 'denied', decision: 'blocked' }))
    const lines = readFileSync(join(tmp.dir, '2026-10-01.ndjson'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(listAudit('2026-10-01')).toHaveLength(2)
    expect(listAudit('2026-10-01', 't_2')).toEqual([
      entry({ task: 't_2', result: 'denied', decision: 'blocked' })
    ])
    expect(listAudit('../etc')).toEqual([])
  })

  it('prunes day files older than the retention at install', () => {
    for (const d of ['2026-08-01', '2026-09-01', '2026-09-30'])
      writeFileSync(join(tmp.dir, `${d}.ndjson`), '')
    writeFileSync(join(tmp.dir, 'notes.txt'), '')
    installAudit(tmp.dir, 30, Date.parse('2026-10-01T12:00:00Z'))
    expect(readdirSync(tmp.dir).sort()).toEqual([
      '2026-09-01.ndjson',
      '2026-09-30.ndjson',
      'notes.txt'
    ])
  })

  it('stores typed text as length + sha256, never plaintext', () => {
    const s = summarizeAction({ type: 'type', text: 'my secret note' }, 'notepad.exe')
    expect(s).toEqual({
      type: 'type',
      text: {
        len: 14,
        sha256: createHash('sha256').update('my secret note').digest('hex')
      },
      app: 'notepad.exe'
    })
    expect(JSON.stringify(s)).not.toContain('secret note')
    const steps = summarizeAction({ type: 'input', steps: [{ t: 'type', text: 'pw' }] })
    expect(JSON.stringify(steps)).not.toContain('"pw"')
  })

  it('keeps typed text only when opted in, with secrets redacted', () => {
    const key = ['sk', 'proj', 'A'.repeat(40)].join('-')
    setAuditStoreTypedText(true)
    try {
      const s = summarizeAction({ type: 'type', text: `hello ${key}` })
      const text = s.text as { len: number; sha256: string; redacted: string }
      expect(text.len).toBe(6 + key.length)
      expect(text.redacted).toContain('hello')
      expect(text.redacted).not.toContain(key)
      const steps = summarizeAction({ type: 'input', steps: [{ t: 'type', text: 'hi there' }] })
      expect(JSON.stringify(steps)).toContain('hi there')
    } finally {
      setAuditStoreTypedText(false)
    }
    expect(JSON.stringify(summarizeAction({ type: 'type', text: 'hello' }))).not.toContain('hello')
  })

  it('redacts secrets in URLs', () => {
    const s = summarizeAction({
      type: 'open_url',
      url: `https://x.com/?k=${'sk-'}abcdefghijklmnop1234`
    })
    expect(String(s.url)).toContain('[redacted:api-key]')
  })

  it('without install nothing is written but the summary still works', () => {
    writeAudit(entry({ action: { type: 'hotkey', keys: 'ctrl+c' } }))
    expect(existsSync(join(tmp.dir, '2026-10-01.ndjson'))).toBe(false)
    expect(lastTaskSummary()).toContain('pressed ctrl+c')
  })

  it('"what did you just do" lists the last task only', () => {
    writeAudit(entry({ task: 'old', action: { type: 'type', text: { len: 3 } } }))
    writeAudit(entry({ task: 'new', action: { type: 'open_url', url: 'https://a.com/' } }))
    writeAudit(
      entry({
        task: 'new',
        action: { type: 'click_element', element: 'Send' },
        result: 'denied',
        decision: 'denied-by-user'
      })
    )
    const s = lastTaskSummary()
    expect(s).toContain('opened https://a.com/')
    expect(s).toContain('click element “Send”: not done (you said no)')
    expect(s).not.toContain('typed')
  })
})
