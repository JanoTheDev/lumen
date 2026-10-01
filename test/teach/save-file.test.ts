import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { saveChosenFile } from '../../src/main/teach/save-file'
import { tempDir } from '../helpers/fixtures'

describe('saveChosenFile (review ipc low #2)', () => {
  it('writes the file and returns its path', () => {
    const tmp = tempDir()
    try {
      const path = join(tmp.dir, 'a.json')
      expect(saveChosenFile(path, '{}\n', 'utf8')).toEqual({ ok: true, path })
      expect(readFileSync(path, 'utf8')).toBe('{}\n')
    } finally {
      tmp.cleanup()
    }
  })

  it('a target it cannot write is { ok: false, error }, not a throw', () => {
    const tmp = tempDir()
    try {
      // A folder where the file should go: the write fails like a locked file would.
      const r = saveChosenFile(tmp.dir, new Uint8Array([1, 2]))
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toMatch(/^Could not save the file/)
    } finally {
      tmp.cleanup()
    }
  })
})
