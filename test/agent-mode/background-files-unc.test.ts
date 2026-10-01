// Background read_file never touches the file system for a network / device path or a path
// outside the granted folders (review M5: realpath on \\host\share sends the NTLM hash).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsCalls = vi.hoisted(() => [] as string[])

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const native = (p: string): string => {
    fsCalls.push(`realpath ${p}`)
    return actual.realpathSync.native(p)
  }
  const realpathSync = Object.assign((p: string) => actual.realpathSync(p), { native })
  return {
    ...actual,
    default: actual,
    realpathSync,
    existsSync: (p: string) => {
      fsCalls.push(`exists ${p}`)
      return actual.existsSync(p)
    },
    statSync: actual.statSync,
    readFileSync: actual.readFileSync
  }
})

import { isRemoteOrDevicePath, readGranted } from '../../src/main/agent-mode/background/files'

const granted = process.platform === 'win32' ? 'C:\\Users\\me\\Notes' : '/home/me/notes'

describe('read_file: UNC and device paths', () => {
  beforeEach(() => {
    fsCalls.length = 0
  })

  it.each([
    '\\\\attacker.example\\s\\notes.txt',
    '//attacker.example/s/notes.txt',
    '\\\\?\\C:\\Users\\me\\Notes\\a.txt',
    '\\\\.\\pipe\\x',
    '\\\\?\\UNC\\host\\share\\a.txt',
    'file://host/share/a.txt',
    `${granted}\0.txt`
  ])('%s is refused before any fs call', (p) => {
    expect(isRemoteOrDevicePath(p)).toBe(true)
    const r = readGranted(p, [granted])
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^E_DENIED/) })
    expect(fsCalls).toEqual([])
  })

  it('a path outside the granted folders is refused before realpath', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts.txt'
    expect(readGranted(outside, [granted])).toMatchObject({ ok: false })
    expect(fsCalls).toEqual([])
  })

  it('a path inside a granted folder does reach the file system (the spy works)', () => {
    readGranted(`${granted}${process.platform === 'win32' ? '\\' : '/'}a.txt`, [granted])
    expect(fsCalls.length).toBeGreaterThan(0)
  })

  it('ordinary drive paths are not remote', () => {
    expect(isRemoteOrDevicePath('C:\\Users\\me\\a.txt')).toBe(false)
    expect(isRemoteOrDevicePath('/home/me/a.txt')).toBe(false)
  })
})
