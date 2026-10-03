import { ACTION_MODE } from './action'
import { ANSWER_CARDS, ANSWER_MODE } from './answer'
import { CLARIFY_MODE } from './clarify'
import { GUIDE_MODE } from './guide'
import { LOCATE_MODE } from './locate'
import { TEXT_INSERT_MODE } from './text-insert'

/** Every mode contract in a fixed order (part of the stable prefix). */
export const MODES = [
  ANSWER_MODE,
  ANSWER_CARDS,
  GUIDE_MODE,
  LOCATE_MODE,
  ACTION_MODE,
  TEXT_INSERT_MODE,
  CLARIFY_MODE
].join('\n\n')
