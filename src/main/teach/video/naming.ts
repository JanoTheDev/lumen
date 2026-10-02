// Where a lesson video goes (07 T30): Videos\Lumen\<lesson>-<date>.webm with its transcript
// <same name>.md beside it. Never over an existing file: the next free "name (2)" is used, and
// the pair is free together. Pure apart from the injected exists check.
import { join } from 'path'
import { freePath, safeStem } from '../../docs-out/place'

export const VIDEO_FOLDER = 'Lumen'

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local calendar date "2026-10-02". */
export function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** "Add an object" on 2 Oct 2026 → "Add an object-2026-10-02" (Windows-safe). */
export function videoStem(title: string, at: Date): string {
  return `${safeStem(title, '.webm', 'Lesson').slice(0, 60).trim()}-${localDate(at)}`
}

export interface VideoPaths {
  video: string
  transcript: string
}

/** The first free `<stem>.webm` + `<stem>.md` pair in `dir`, else null. */
export function videoPaths(
  dir: string,
  title: string,
  at: Date,
  exists: (p: string) => boolean
): VideoPaths | null {
  const transcriptOf = (video: string): string => video.replace(/\.webm$/i, '.md')
  const video = freePath(
    join(dir, VIDEO_FOLDER),
    videoStem(title, at),
    '.webm',
    (p) => exists(p) || exists(transcriptOf(p))
  )
  return video ? { video, transcript: transcriptOf(video) } : null
}
