import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setConfigDir } from '../../src/main/config'
import {
  archivePending,
  clearPending,
  dictationDir,
  recoveredFile,
  recoveryMessage,
  savePending,
  takeRecoverable
} from '../../src/main/speech/dictation/recovery'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-dictation-'))
  setConfigDir(dir)
})

afterEach(() => {
  setConfigDir(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('dictation recovery', () => {
  it('nothing to recover after text was typed', () => {
    const id = savePending('typed fine')
    clearPending(id)
    expect(takeRecoverable()).toEqual([])
  })

  it('text saved but never typed (crash) is recovered on the next launch, once', () => {
    savePending('second', 2000)
    savePending('first', 1000)
    const items = takeRecoverable()
    expect(items.map((i) => i.text)).toEqual(['first', 'second'])
    expect(readFileSync(recoveredFile(), 'utf8')).toContain('first')
    expect(takeRecoverable()).toEqual([])
    expect(recoveryMessage(items)).toContain('first\n\nsecond')
  })

  it('clearing one entry keeps the others', () => {
    const a = savePending('a')
    savePending('b')
    clearPending(a)
    expect(takeRecoverable().map((i) => i.text)).toEqual(['b'])
  })

  it('a torn last line from a crash mid-write is skipped', () => {
    savePending('kept')
    const file = join(dictationDir(), 'pending.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8') + '{"id":"x","t":1,"te', 'utf8')
    expect(takeRecoverable().map((i) => i.text)).toEqual(['kept'])
  })

  it('archivePending moves a failed insert straight to recovered.txt', () => {
    const id = savePending('could not type')
    archivePending(id)
    expect(existsSync(join(dictationDir(), 'pending.jsonl'))).toBe(false)
    expect(readFileSync(recoveredFile(), 'utf8')).toContain('could not type')
    expect(takeRecoverable()).toEqual([])
  })
})
