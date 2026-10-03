import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicFiles } from '../../src/main/agent-mode/atomic-file'
import { tempDir } from '../helpers/fixtures'

let tmp: ReturnType<typeof tempDir> | null = null
afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

describe('AtomicFiles', () => {
  it('a background write that ends after a newer one leaves the newer content', async () => {
    tmp = tempDir()
    const f = new AtomicFiles()
    const file = join(tmp.dir, 'sub', 'a.json')
    const old = f.write(file, 'old')
    f.writeSync(file, 'new')
    await old
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(readdirSync(join(tmp.dir, 'sub'))).toEqual(['a.json'])
  })

  it('the last of several background writes wins; forget drops them', async () => {
    tmp = tempDir()
    const f = new AtomicFiles()
    const file = join(tmp.dir, 'b.json')
    await Promise.all([f.write(file, '1'), f.write(file, '2')])
    expect(readFileSync(file, 'utf8')).toBe('2')
    const late = f.write(file, '3')
    f.forget(file)
    await late
    expect(readFileSync(file, 'utf8')).toBe('2')
    expect(readdirSync(tmp.dir)).toEqual(['b.json'])
  })
})
