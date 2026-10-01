// Picks the speech-to-text engine. Local is the free default; cloud (OpenAI) is used when the
// user chose it and has a key, or as a stand-in while the local model is still downloading.
export type SttPref = 'local' | 'cloud-batch' | 'cloud-stream'
export type SttEngine = 'local' | 'cloud'

export interface SttAvailability {
  openaiKey: boolean
  localSupported: boolean
  localInstalled: boolean
  /** An offline model exists for the voice language (default true). */
  localLanguage?: boolean
}

export type SttDecision =
  | { engine: SttEngine }
  | { engine: null; reason: 'installing' | 'no-engine' | 'language' }

export function chooseStt(pref: SttPref, a: SttAvailability): SttDecision {
  const localReady = a.localSupported && a.localInstalled
  if (pref !== 'local' && a.openaiKey) return { engine: 'cloud' }
  if (a.localLanguage === false)
    return a.openaiKey ? { engine: 'cloud' } : { engine: null, reason: 'language' }
  if (localReady) return { engine: 'local' }
  if (a.openaiKey) return { engine: 'cloud' }
  return { engine: null, reason: a.localSupported ? 'installing' : 'no-engine' }
}

/** The local model should be fetched: it is (or will be) the engine in use and is missing. */
export function wantsLocalModel(pref: SttPref, a: SttAvailability): boolean {
  if (a.localLanguage === false) return false
  return (pref === 'local' || !a.openaiKey) && a.localSupported && !a.localInstalled
}
