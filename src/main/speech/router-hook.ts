// Runs in the query IPC before the confirm / lesson / grammar / cancel chain (see router.ts):
//   - short answers in the voice language become the English word that chain understands
//     ("sí" → "yes", "abbrechen" → "stop", "siguiente" → "next")
//   - "stop, open notepad" while an action or plan runs cancels it, then the rest is the request
import type { VoiceLanguage } from '@shared/config'
import { loadConfig } from '../config'
import { log } from '../logger'
import { cancelAll } from '../query/cancel'
import { canonicalUtterance } from './lexicon'
import { routeUtterance } from './router'
import { cancelArmed } from './wake/arm'

export interface HookDeps {
  lang: () => VoiceLanguage
  busy: () => boolean
  cancel: () => boolean
}

const appDeps: HookDeps = {
  lang: () => loadConfig().voice.language,
  busy: cancelArmed,
  cancel: cancelAll
}

/** The text the query IPC goes on with. */
export function prepareVoiceText(text: string, deps: HookDeps = appDeps): string {
  const lang = deps.lang()
  if (deps.busy()) {
    const r = routeUtterance(text, {
      confirmPending: false,
      lessonRunning: false,
      busy: true,
      grammar: false,
      lang
    })
    if (r.kind === 'cancel' && r.rest) {
      if (deps.cancel()) log('skip', 'voice cancel at the start of a request: aborting')
      return r.rest
    }
  }
  return canonicalUtterance(text, lang)
}
