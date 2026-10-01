import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative, sep } from 'path'
import { DEFAULT_CONFIG_V2 } from '../../src/shared/config'
import { createMemory, type Memory, type MemorySettings } from '../../src/main/ai/memory'

export interface Harness {
  dir: string
  mem: Memory
  settings: MemorySettings
  clock: { now: Date }
  files: () => string[]
  cleanup: () => void
}

export function harness(overrides: Partial<MemorySettings> = {}, dir?: string): Harness {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'lumen-mem-'))
  const settings: MemorySettings = { ...DEFAULT_CONFIG_V2.memory, enabled: true, ...overrides }
  const clock = { now: new Date('2026-10-01T12:00:00Z') }
  const mem = createMemory({
    dir: root,
    settings: () => settings,
    now: () => clock.now,
    index: 'json-bm25',
    log: () => {}
  })
  const files = (): string[] => {
    const out: string[] = []
    const walk = (d: string): void => {
      let entries: string[] = []
      try {
        entries = readdirSync(d)
      } catch {
        return
      }
      for (const e of entries) {
        const full = join(d, e)
        if (statSync(full).isDirectory()) walk(full)
        else out.push(relative(root, full).split(sep).join('/'))
      }
    }
    walk(root)
    return out.sort()
  }
  return {
    dir: root,
    mem,
    settings,
    clock,
    files,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}
