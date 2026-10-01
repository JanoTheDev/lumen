// Dictation feedback and hands-free extras (04 T47/T48): the caret pill, media ducking, mouse
// push-to-talk and the spoken commands ("press enter", "send it", "whisper mode on") around
// the dictation pipeline. Start / stop sounds and whisper gain live in the voice renderer.
import type { AgentBridge } from '../agent/bridge'
import { installCaretPill } from './caret-pill'
import { installMediaDucking, restoreMedia } from './duck'
import { installMousePtt } from './mouse-ptt'
import { dictateWithSpokenKeys, type DictateFn } from './spoken-keys'

export function installDictationExtras(agent: AgentBridge): void {
  installCaretPill(agent)
  installMediaDucking(agent)
  installMousePtt(agent)
}

/** The `voice:dictate` handler: media back up, spoken commands applied around `dictate`. */
export function dictationHandler(dictate: DictateFn): DictateFn {
  return (text) => {
    restoreMedia()
    return dictateWithSpokenKeys(text, dictate)
  }
}
