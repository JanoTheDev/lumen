// A buddy folder's real path (08 T50 review): junctions ("Application Data" → AppData\Roaming)
// and 8.3 short names ("PROGRA~1") are resolved before the folder checks, so a path that only
// looks harmless cannot reach a blocked folder. A folder that does not exist yet is resolved
// through its deepest existing parent. The realpath port keeps it testable.
import { realpathSync } from 'fs'
import { win32 } from 'path'

export type RealPath = (p: string) => string

const nativeReal: RealPath = (p) => realpathSync.native(p)

/** `\\?\C:\x` → `C:\x`; a `\\?\UNC\…` path stays a UNC path (refused by the checks). */
export function plainPath(p: string): string {
  if (/^\\\\\?\\UNC\\/i.test(p)) return `\\\\${p.slice(8)}`
  if (/^\\\\\?\\[A-Za-z]:\\/.test(p)) return p.slice(4)
  return p
}

/**
 * The real long path of `p` (its deepest existing parent resolved, the rest joined back), or
 * null when nothing of it resolves (a missing drive): then only the written path is checked.
 */
export function realFolder(p: string, real: RealPath = nativeReal): string | null {
  let head = win32.resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      return plainPath(win32.join(real(head), ...rest))
    } catch {
      const up = win32.dirname(head)
      if (up === head) return null
      rest.unshift(win32.basename(head))
      head = up
    }
  }
}
