import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { GrantStore } from '../../src/main/agent-mode/grants'
import { tempDir } from '../helpers/fixtures'

describe('GrantStore', () => {
  let tmp: ReturnType<typeof tempDir>
  let file: string

  beforeEach(() => {
    tmp = tempDir()
    file = join(tmp.dir, 'grants.json')
  })
  afterEach(() => tmp.cleanup())

  it('stores a medium grant and reloads it', () => {
    const s = new GrantStore(file)
    expect(s.add('app:outlook.exe')).toBe(true)
    expect(s.has('app:outlook.exe')).toBe(true)
    const again = new GrantStore(file)
    expect(again.list()).toEqual([
      { scope: 'app:outlook.exe', level: 'medium', createdAt: expect.any(String) }
    ])
  })

  it('never grants high risk or a malformed scope', () => {
    const s = new GrantStore(file)
    expect(s.add('app:outlook.exe', 'high')).toBe(false)
    expect(s.add('app:outlook.exe', 'blocked')).toBe(false)
    expect(s.add('anything')).toBe(false)
    expect(s.add('app:has space')).toBe(false)
    expect(s.list()).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('revokes', () => {
    const s = new GrantStore(file)
    s.add('domain:github.com')
    s.add('mcp:fs/read_file')
    expect(s.revoke('domain:github.com')).toBe(true)
    expect(s.revoke('domain:github.com')).toBe(false)
    expect(new GrantStore(file).list().map((g) => g.scope)).toEqual(['mcp:fs/read_file'])
  })

  it('a broken or tampered file grants nothing high', () => {
    writeFileSync(file, '{not json')
    expect(new GrantStore(file).list()).toEqual([])
    writeFileSync(
      file,
      JSON.stringify({
        grants: [
          { scope: 'app:x.exe', level: 'high', createdAt: '' },
          { scope: 'app:y.exe', level: 'medium', createdAt: '' }
        ]
      })
    )
    expect(new GrantStore(file).list().map((g) => g.scope)).toEqual(['app:y.exe'])
  })

  it('writes atomically (no temp file left)', () => {
    new GrantStore(file).add('scheme:mailto')
    expect(JSON.parse(readFileSync(file, 'utf8')).grants).toHaveLength(1)
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
  })
})
