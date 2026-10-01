// "Summarize this file" / "convert that to Excel" while pointing at a file in File Explorer
// or on the desktop: the file under the pointer (where it was while "this" was said, or the
// middle of a circling motion; deictic/) is shared like a drop, so the request's normal path
// (answer, agent task, make a file) reads it through attach.ts.
import type { Point } from '@shared/types'
import { log } from '../logger'
import { fileAt, mentionsPointedFile, realPointedDeps, type PointedDeps } from './pointed'
import { registerFile } from './store'

export type Shared = { ok: true; id: string } | { ok: false; error: string } | null

export interface ShareDeps {
  point(utterance: string): Point
  pointed(): Promise<PointedDeps>
  register: typeof registerFile
}

/** Shares the pointed file when the request is about one; null when it is not. */
export async function sharePointedFile(prompt: string, deps?: ShareDeps): Promise<Shared> {
  if (!mentionsPointedFile(prompt)) return null
  const d = deps ?? (await realShareDeps())
  const r = await fileAt(d.point(prompt), await d.pointed())
  if (!r) return null
  if (!r.ok) {
    log('skip', `pointed file: ${r.error}`)
    return r
  }
  const reg = await d.register(r.path)
  if (!reg.ok) return { ok: false, error: reg.error }
  log('plan', `pointed file shared: ${reg.file.kind} as ${reg.file.id}`)
  return { ok: true, id: reg.file.id }
}

async function realShareDeps(): Promise<ShareDeps> {
  const { pointedAt } = await import('../deictic')
  return { point: pointedAt, pointed: realPointedDeps, register: registerFile }
}
