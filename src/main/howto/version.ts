// The app's identity for how-to lookups and app notes: display name from the process, version
// from the exe's VS_FIXEDFILEINFO (PE .rsrc section, read directly: no PowerShell, no native
// call). Cached per path. No Electron.
import { closeSync, openSync, readSync, statSync } from 'fs'
import { appIdOf } from '../ai/memory/profile'
import type { AppIdentity } from './types'

const FIXED_SIG = 0xfeef04bd
const MAX_RSRC_BYTES = 16 * 1024 * 1024

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len)
  const n = readSync(fd, buf, 0, len, pos)
  return buf.subarray(0, n)
}

/** "a.b.c.d" from a VS_FIXEDFILEINFO block at `off`, or '' when the signature is not there. */
export function fixedVersionAt(buf: Buffer, off: number): string {
  if (off + 24 > buf.length || buf.readUInt32LE(off) !== FIXED_SIG) return ''
  // dwProductVersionMS/LS (+16/+20) is what About boxes show; file version (+8/+12) as backup.
  const ms = buf.readUInt32LE(off + 16) || buf.readUInt32LE(off + 8)
  const ls = buf.readUInt32LE(off + 16) ? buf.readUInt32LE(off + 20) : buf.readUInt32LE(off + 12)
  if (!ms && !ls) return ''
  return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.')
}

/** The version in a resource section buffer (first VS_FIXEDFILEINFO, 4-byte aligned). */
export function versionInResources(rsrc: Buffer): string {
  for (let i = 0; i + 4 <= rsrc.length; i += 4) {
    if (rsrc.readUInt32LE(i) === FIXED_SIG) {
      const v = fixedVersionAt(rsrc, i)
      if (v) return v
    }
  }
  return ''
}

/** Reads the .rsrc section of a PE file; null when it is not a PE or has no resources. */
export function readResourceSection(path: string): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const dos = readAt(fd, 0, 64)
    if (dos.length < 64 || dos.toString('latin1', 0, 2) !== 'MZ') return null
    const pe = dos.readUInt32LE(0x3c)
    const head = readAt(fd, pe, 24)
    if (head.length < 24 || head.readUInt32LE(0) !== 0x00004550) return null
    const sections = head.readUInt16LE(6)
    const optSize = head.readUInt16LE(20)
    const table = readAt(fd, pe + 24 + optSize, sections * 40)
    for (let i = 0; i + 40 <= table.length; i += 40) {
      const name = table.toString('latin1', i, i + 8).replace(/\0+$/, '')
      if (name !== '.rsrc') continue
      const size = Math.min(table.readUInt32LE(i + 16), MAX_RSRC_BYTES)
      const ptr = table.readUInt32LE(i + 20)
      return readAt(fd, ptr, size)
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const cache = new Map<string, { mtime: number; version: string }>()

/** The exe's product version ("11.2402.22.0"), '' when unknown. Cached per path + mtime. */
export function exeVersion(path: string): string {
  if (!path || !/\.exe$/i.test(path)) return ''
  let mtime = 0
  try {
    mtime = statSync(path).mtimeMs
  } catch {
    return ''
  }
  const hit = cache.get(path)
  if (hit && hit.mtime === mtime) return hit.version
  const rsrc = readResourceSection(path)
  const version = rsrc ? versionInResources(rsrc) : ''
  if (cache.size > 100) cache.clear()
  cache.set(path, { mtime, version })
  return version
}

const KNOWN_NAMES: Record<string, string> = {
  winword: 'Microsoft Word',
  excel: 'Microsoft Excel',
  powerpnt: 'Microsoft PowerPoint',
  outlook: 'Microsoft Outlook',
  olk: 'Outlook (new)',
  onenote: 'Microsoft OneNote',
  msaccess: 'Microsoft Access',
  mspub: 'Microsoft Publisher',
  'ms-teams': 'Microsoft Teams',
  explorer: 'File Explorer',
  systemsettings: 'Windows Settings',
  msedge: 'Microsoft Edge',
  chrome: 'Google Chrome',
  firefox: 'Firefox',
  code: 'Visual Studio Code',
  devenv: 'Visual Studio',
  mspaint: 'Paint',
  notepad: 'Notepad',
  'notepad++': 'Notepad++',
  acrobat: 'Adobe Acrobat',
  acrord32: 'Adobe Acrobat Reader',
  photoshop: 'Adobe Photoshop',
  'gimp-2.10': 'GIMP',
  obs64: 'OBS Studio',
  vlc: 'VLC media player',
  soffice: 'LibreOffice',
  'soffice.bin': 'LibreOffice'
}

/** "C:\…\WINWORD.EXE" → "Microsoft Word"; unknown names are title-cased ("blender" → "Blender"). */
export function appNameOf(process: string): string {
  const base = (process.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').trim()
  if (!base) return ''
  const known = KNOWN_NAMES[base.toLowerCase()]
  if (known) return known
  return base.charAt(0).toUpperCase() + base.slice(1)
}

/** Whether how-tos for this app live on Microsoft Learn / Support. */
export function isMicrosoftApp(app: string): boolean {
  return /\b(microsoft|windows|outlook|word|excel|powerpoint|onenote|teams|edge|file explorer|notepad|paint|visual studio|access|publisher)\b/i.test(
    app
  )
}

/** The identity of a foreground window (process name + exe path). */
export function identityOf(win: { process: string; exe?: string }): AppIdentity {
  const app = appNameOf(win.process || win.exe || '')
  return {
    app: app || 'this app',
    appId: appIdOf(app || 'unknown'),
    version: win.exe ? exeVersion(win.exe) : ''
  }
}

/** "11.2402.22.0" → "11" (the part a how-to depends on). */
export function majorOf(version: string): string {
  return version.split('.')[0] ?? ''
}
