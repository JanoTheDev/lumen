// Lesson recording voice words (07 T30). Whole utterances only, consulted only while a lesson
// runs: "record this lesson" starts a video, "stop recording the lesson" ends it. Plain
// "stop recording" also ends it, but only while a lesson video is being made (record my steps
// cannot run during a lesson, so the words are free then).
import { normalize } from '../../a11y/voice-commands'

export type VideoCommand = 'start' | 'stop'

const START =
  /^(?:(?:please )?(?:start )?record(?:ing)?|make a (?:video|recording) of|film|capture) (?:this|the|my) lesson(?: (?:as a video|on video|for me))?$|^(?:start (?:a )?(?:lesson )?(?:video|recording)|record (?:a )?video of (?:this|the) lesson|start recording the lesson)$/

const STOP =
  /^(?:stop|end|finish) (?:recording|filming|capturing) (?:this|the|my) lesson$|^(?:stop|end|finish) (?:the )?lesson (?:recording|video)$/

const PLAIN_STOP = /^(?:stop|end|finish) (?:the )?(?:recording|video|filming)$/

/** "record this lesson" → start, "stop recording the lesson" → stop; `active`: a video runs. */
export function matchVideoCommand(utterance: string, active: boolean): VideoCommand | null {
  if (!utterance || utterance.length > 80) return null
  const n = normalize(utterance)
  if (START.test(n)) return 'start'
  if (STOP.test(n)) return 'stop'
  if (active && PLAIN_STOP.test(n)) return 'stop'
  return null
}
