// The main.log tee: buffered appends, one redaction per line, secrets never on disk.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from '../helpers/fixtures'

const fsCalls = vi.hoisted(() => ({ appendFile: 0, appendFileSync: 0 }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const appendFile = ((...args: Parameters<typeof actual.appendFile>) => {
    fsCalls.appendFile++
    return actual.appendFile(...args)
  }) as typeof actual.appendFile
  const appendFileSync: typeof actual.appendFileSync = (...args) => {
    fsCalls.appendFileSync++
    return actual.appendFileSync(...args)
  }
  const fns = { appendFile, appendFileSync }
  return { ...actual, ...fns, default: { ...actual, ...fns } }
})

const KEY = ['sk', 'proj', 'Q'.repeat(36)].join('-')
const TOKEN = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'x'.repeat(43)].join('.')

type LogFile = typeof import('../../src/main/diagnostics/log-file')
const LEVELS = ['log', 'info', 'warn', 'error'] as const

describe('main.log tee', () => {
  let tmp: ReturnType<typeof tempDir>
  let mod: LogFile
  let saved: Record<(typeof LEVELS)[number], (...a: unknown[]) => void>
  const file = (): string => join(tmp.dir, 'main.log')
  const read = (): string => (existsSync(file()) ? readFileSync(file(), 'utf8') : '')

  beforeEach(async () => {
    tmp = tempDir()
    saved = { log: console.log, info: console.info, warn: console.warn, error: console.error }
    for (const l of LEVELS) console[l] = () => {}
    vi.resetModules()
    mod = await import('../../src/main/diagnostics/log-file')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mod.installLogFile(tmp.dir)
    mod.flushLogFile()
    fsCalls.appendFile = 0
    fsCalls.appendFileSync = 0
  })
  afterEach(() => {
    mod.flushLogFile()
    process.removeListener('exit', mod.flushLogFile)
    for (const l of LEVELS) console[l] = saved[l]
    vi.useRealTimers()
    tmp.cleanup()
  })

  it('1000 console lines in one window make one append', async () => {
    for (let i = 0; i < 1000; i++) console.log('[bridge] event', i)
    expect(fsCalls.appendFile + fsCalls.appendFileSync).toBe(0)
    vi.advanceTimersByTime(250)
    expect(fsCalls.appendFile).toBe(1)
    expect(fsCalls.appendFileSync).toBe(0)
    await vi.waitFor(() => expect(read().match(/\[bridge\] event/g)).toHaveLength(1000))
  })

  it('a full 64 KB buffer flushes before the timer', () => {
    const big = 'y'.repeat(1000)
    for (let i = 0; i < 70; i++) console.log(big)
    expect(fsCalls.appendFile).toBe(1)
  })

  it('secrets never reach the file through a buffered flush', async () => {
    console.error('[x] failed:', `key ${KEY}`)
    console.warn(`[bridge] non-JSON: token=${TOKEN}`)
    vi.advanceTimersByTime(250)
    await vi.waitFor(() => expect(read()).toContain('[bridge] non-JSON'))
    expect(read()).not.toContain(KEY)
    expect(read()).not.toContain(TOKEN)
  })

  it('the exit flush writes what is buffered, redacted', () => {
    expect(process.listeners('exit')).toContain(mod.flushLogFile)
    console.log(`Authorization: Bearer ${KEY}`)
    mod.flushLogFile()
    expect(fsCalls.appendFileSync).toBe(1)
    expect(read()).toContain('Authorization')
    expect(read()).not.toContain(KEY)
  })

  it('log() lines are redacted once, by log(), and still never leak', async () => {
    const actions = await import('../../src/main/actions/redact')
    const spy = vi.spyOn(actions, 'redactForLog')
    const { log } = await import('../../src/main/logger')
    log('fail', `request failed with ${KEY}`)
    expect(spy).toHaveBeenCalledTimes(1)
    log('done', 'complete', { model: 'gpt-5-nano' })
    mod.flushLogFile()
    expect(read()).toContain('[fail]')
    expect(read()).toContain('| gpt-5-nano')
    expect(read()).not.toContain(KEY)
    spy.mockRestore()
  })

  it('raw console lines are still redacted after a log() line', async () => {
    const { log } = await import('../../src/main/logger')
    log('plan', 'step one')
    console.log(`raw ${KEY}`)
    mod.flushLogFile()
    expect(read()).toContain('step one')
    expect(read()).toContain('raw ')
    expect(read()).not.toContain(KEY)
  })
})
