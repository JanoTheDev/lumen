import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppIdentity } from '../../src/main/howto/types'

const writes = vi.hoisted(() => ({ n: 0 }))
vi.mock('fs', async (orig) => {
  const fs = await orig<typeof import('fs')>()
  return {
    ...fs,
    writeFileSync: (...a: Parameters<typeof fs.writeFileSync>) => {
      writes.n++
      return fs.writeFileSync(...a)
    }
  }
})

import { AppNotesStore, flushAppNotes } from '../../src/main/howto/notes'

const root = mkdtempSync(join(tmpdir(), 'lumen-notes-flush-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const fresh = (): string => join(root, `d${++n}`)

const PAINT: AppIdentity = { app: 'Paint.NET', appId: 'paintdotnet', version: '5.1.2.0' }
const PATH = { ui: ['Image', 'Resize'] }
const onDisk = (dir: string): { notes: { goal: string; uses: number }[] } | null => {
  const file = join(dir, 'paintdotnet.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

describe('app notes writes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    writes.n = 0
  })
  afterEach(() => {
    flushAppNotes()
    vi.useRealTimers()
  })

  it('writes three identical successes once, after the debounce', () => {
    const dir = fresh()
    const s = new AppNotesStore(dir)
    for (let i = 0; i < 3; i++) s.recordSuccess(PAINT, 'Resize the image', PATH)
    expect(writes.n).toBe(0)
    expect(s.find(PAINT, 'resize the image')?.uses).toBe(3)
    vi.advanceTimersByTime(5000)
    expect(writes.n).toBe(1)
    expect(onDisk(dir)?.notes).toMatchObject([{ goal: 'Resize the image', uses: 3 }])
  })

  it('persists a dropped note at once', () => {
    const dir = fresh()
    const s = new AppNotesStore(dir)
    s.recordSuccess(PAINT, 'Resize the image', PATH)
    s.recordSuccess(PAINT, 'Add a layer', { ui: ['Layers', 'Add New Layer'] })
    flushAppNotes()
    expect(s.recordFailure(PAINT, 'Add a layer')).toBe(false)
    expect(s.recordFailure(PAINT, 'Add a layer')).toBe(true)
    expect(onDisk(dir)?.notes.map((x) => x.goal)).toEqual(['Resize the image'])
    expect(new AppNotesStore(dir).find(PAINT, 'add a layer')).toBeNull()
  })

  it('never writes notes back after forget', () => {
    const dir = fresh()
    const s = new AppNotesStore(dir)
    s.recordSuccess(PAINT, 'Resize the image', PATH)
    flushAppNotes()
    s.recordSuccess(PAINT, 'Add a layer', { ui: ['Layers'] })
    s.forget(PAINT.appId)
    vi.advanceTimersByTime(5000)
    flushAppNotes()
    expect(onDisk(dir)).toBeNull()
    expect(s.list(PAINT.appId)).toEqual([])
  })
})
