// Writes a file the user picked in a save dialog. A locked, read-only or vanished target
// becomes { ok: false, error } for the Settings page instead of a rejected invoke.
import { writeFileSync } from 'fs'

export type SaveResult = { ok: true; path: string } | { ok: false; error: string }

export function saveChosenFile(
  path: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding
): SaveResult {
  try {
    writeFileSync(path, data, encoding)
    return { ok: true, path }
  } catch (e) {
    return { ok: false, error: `Could not save the file: ${(e as Error).message}` }
  }
}
