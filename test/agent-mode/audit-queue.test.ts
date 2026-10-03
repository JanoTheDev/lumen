import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from '../helpers/fixtures'

const fsCalls = vi.hoisted(() => ({ appendFileSync: 0 }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const appendFileSync: typeof actual.appendFileSync = (...args) => {
    fsCalls.appendFileSync++
    return actual.appendFileSync(...args)
  }
  return { ...actual, default: { ...actual, appendFileSync }, appendFileSync }
})

import {
  flushAudit,
  installAudit,
  listAudit,
  uninstallAudit,
  writeAudit,
  type AuditEntry
} from '../../src/main/audit/log'

const DAY = '2026-10-01'
const entry = (i: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  t: `${DAY}T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
  task: 't_1',
  origin: 'agent',
  action: { type: 'click', element: `Button ${i}` },
  risk: 'low',
  decision: 'auto',
  result: 'ok',
  ms: 3,
  ...over
})

describe('audit log queue', () => {
  let tmp: ReturnType<typeof tempDir>

  beforeEach(() => {
    tmp = tempDir()
    vi.useFakeTimers()
    installAudit(tmp.dir, 30, Date.parse(`${DAY}T12:00:00Z`))
    fsCalls.appendFileSync = 0
  })
  afterEach(() => {
    uninstallAudit()
    vi.useRealTimers()
    tmp.cleanup()
  })

  it('50 entries become one append, and listAudit sees them at once', () => {
    for (let i = 0; i < 50; i++) writeAudit(entry(i))
    expect(fsCalls.appendFileSync).toBe(0)
    const listed = listAudit(DAY)
    expect(listed).toHaveLength(50)
    expect(listed[49]).toEqual(entry(49))
    expect(fsCalls.appendFileSync).toBe(1)
  })

  it('flushes on the 200 ms timer', () => {
    for (let i = 0; i < 50; i++) writeAudit(entry(i))
    vi.advanceTimersByTime(199)
    expect(existsSync(join(tmp.dir, `${DAY}.ndjson`))).toBe(false)
    vi.advanceTimersByTime(1)
    expect(fsCalls.appendFileSync).toBe(1)
    const lines = readFileSync(join(tmp.dir, `${DAY}.ndjson`), 'utf8')
      .trim()
      .split('\n')
    expect(lines).toHaveLength(50)
  })

  it('a high-risk entry is written right away, with what was queued before it', () => {
    writeAudit(entry(1))
    writeAudit(entry(2, { risk: 'high', decision: 'confirmed-by-user' }))
    expect(fsCalls.appendFileSync).toBe(1)
    expect(
      readFileSync(join(tmp.dir, `${DAY}.ndjson`), 'utf8')
        .trim()
        .split('\n')
    ).toHaveLength(2)
  })

  it('the exit hook writes what is still queued', () => {
    writeAudit(entry(1))
    expect(process.listeners('exit')).toContain(flushAudit)
    flushAudit()
    expect(
      readFileSync(join(tmp.dir, `${DAY}.ndjson`), 'utf8')
        .trim()
        .split('\n')
    ).toHaveLength(1)
  })

  it('keeps day files apart', () => {
    writeAudit(entry(1))
    writeAudit(entry(2, { t: '2026-10-02T00:00:01.000Z' }))
    flushAudit()
    expect(fsCalls.appendFileSync).toBe(2)
    expect(listAudit(DAY)).toHaveLength(1)
    expect(listAudit('2026-10-02')).toHaveLength(1)
  })
})
