// Face settings: whether a polled face:state would change what the section draws.
import type { FaceState } from '@shared/channels'

/** Same on screen: the fields this section draws (frame scores beyond "face seen" are not). */
export function sameFaceState(a: FaceState | null, b: FaceState): boolean {
  if (!a) return false
  if (
    a.installed !== b.installed ||
    a.installing !== b.installing ||
    a.status !== b.status ||
    a.error !== b.error ||
    a.calibrating !== b.calibrating ||
    !!a.frame?.face !== !!b.frame?.face ||
    a.last?.at !== b.last?.at
  )
    return false
  const ap = a.pointer
  const bp = b.pointer
  if (
    ap !== bp &&
    (!ap ||
      !bp ||
      ap.paused !== bp.paused ||
      ap.nx !== bp.nx ||
      ap.ny !== bp.ny ||
      ap.deadX !== bp.deadX ||
      ap.deadY !== bp.deadY)
  )
    return false
  const ak = Object.keys(a.levels)
  return ak.length === Object.keys(b.levels).length && ak.every((k) => a.levels[k] === b.levels[k])
}
