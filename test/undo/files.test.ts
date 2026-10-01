import { existsSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { UndoTrash } from '../../src/main/undo/files'
import { tempDir } from '../helpers/fixtures'

describe('UndoTrash', () => {
  const dirs: { cleanup(): void }[] = []
  afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()))
  const mk = (): string => {
    const d = tempDir('undo-')
    dirs.push(d)
    return d.dir
  }

  it('keeps a copy and puts it back', () => {
    const root = mk()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'before')
    const trash = new UndoTrash(join(root, 'trash'))
    const copy = trash.backup(file, 'u1')!
    writeFileSync(file, 'after')
    trash.restore(file, copy, 'u1')
    expect(readFileSync(file, 'utf8')).toBe('before')
  })

  it('a file Lumen created is moved into the trash on undo, never deleted', () => {
    const root = mk()
    const file = join(root, 'new.txt')
    const trash = new UndoTrash(join(root, 'trash'))
    expect(trash.backup(file, 'u2')).toBeNull()
    writeFileSync(file, 'x')
    trash.restore(file, null, 'u2')
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(join(root, 'trash', 'u2-created', 'new.txt'), 'utf8')).toBe('x')
  })

  it('prunes old copies', () => {
    const root = mk()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'x')
    const trash = new UndoTrash(join(root, 'trash'))
    trash.backup(file, 'old')
    const old = new Date(Date.now() - 3 * 86_400_000)
    utimesSync(join(root, 'trash', 'old'), old, old)
    expect(trash.prune()).toBe(1)
    expect(existsSync(join(root, 'trash', 'old'))).toBe(false)
  })
})
