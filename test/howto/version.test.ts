import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  appNameOf,
  exeVersion,
  identityOf,
  isMicrosoftApp,
  majorOf,
  versionInResources
} from '../../src/main/howto/version'

const dir = mkdtempSync(join(tmpdir(), 'lumen-howto-ver-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A minimal PE: DOS header, PE header, one .rsrc section holding a VS_FIXEDFILEINFO. */
function fakePe(product: [number, number, number, number]): Buffer {
  const pe = 0x80
  const optSize = 0xe0
  const table = pe + 24 + optSize
  const rsrcAt = 0x400
  const buf = Buffer.alloc(rsrcAt + 0x200)
  buf.write('MZ', 0, 'latin1')
  buf.writeUInt32LE(pe, 0x3c)
  buf.writeUInt32LE(0x00004550, pe)
  buf.writeUInt16LE(1, pe + 6)
  buf.writeUInt16LE(optSize, pe + 20)
  buf.write('.rsrc', table, 'latin1')
  buf.writeUInt32LE(0x200, table + 16)
  buf.writeUInt32LE(rsrcAt, table + 20)
  // VS_VERSION_INFO noise, then the fixed info at a 4-byte boundary.
  buf.write('V\0S\0_\0V\0E\0R\0', rsrcAt + 6, 'latin1')
  const fixed = rsrcAt + 0x28
  buf.writeUInt32LE(0xfeef04bd, fixed)
  buf.writeUInt32LE((1 << 16) | 0, fixed + 8)
  buf.writeUInt32LE(0, fixed + 12)
  buf.writeUInt32LE(((product[0] << 16) | product[1]) >>> 0, fixed + 16)
  buf.writeUInt32LE(((product[2] << 16) | product[3]) >>> 0, fixed + 20)
  return buf
}

describe('exe version', () => {
  it('reads the product version from the resource section', () => {
    const path = join(dir, 'Notepad.exe')
    writeFileSync(path, fakePe([11, 2402, 22, 0]))
    expect(exeVersion(path)).toBe('11.2402.22.0')
    expect(majorOf('11.2402.22.0')).toBe('11')
  })

  it('is empty for non-PE files, missing files and non-exe paths', () => {
    const path = join(dir, 'text.exe')
    writeFileSync(path, 'not a program')
    expect(exeVersion(path)).toBe('')
    expect(exeVersion(join(dir, 'missing.exe'))).toBe('')
    expect(exeVersion(join(dir, 'x.dll'))).toBe('')
    expect(versionInResources(Buffer.alloc(64))).toBe('')
  })
})

describe('app identity', () => {
  it('names known and unknown apps', () => {
    expect(appNameOf('C:\\Program Files\\Microsoft Office\\WINWORD.EXE')).toBe('Microsoft Word')
    expect(appNameOf('blender.exe')).toBe('Blender')
    expect(isMicrosoftApp('Microsoft Word')).toBe(true)
    expect(isMicrosoftApp('Notepad')).toBe(true)
    expect(isMicrosoftApp('Blender')).toBe(false)
  })

  it('builds an id and reads the version from the exe', () => {
    const exe = join(dir, 'krita.exe')
    writeFileSync(exe, fakePe([5, 2, 3, 0]))
    expect(identityOf({ process: 'krita.exe', exe })).toEqual({
      app: 'Krita',
      appId: 'krita',
      version: '5.2.3.0'
    })
  })
})
