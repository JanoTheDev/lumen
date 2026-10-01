// Loads the sherpa-onnx native addon once (local STT and the wake-word spotter share it).
import { log } from '../logger'

export type Sherpa = typeof import('sherpa-onnx-node')

let sherpa: Sherpa | null | undefined

/** The addon, or null when it does not load on this machine (logged once). */
export function loadSherpa(): Sherpa | null {
  if (sherpa !== undefined) return sherpa
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require('sherpa-onnx-node') as Sherpa
  } catch (e) {
    log('fail', `local speech engine unavailable: ${(e as Error).message.split('\n')[0]}`)
    sherpa = null
  }
  return sherpa
}
