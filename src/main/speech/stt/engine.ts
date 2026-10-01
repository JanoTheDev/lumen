// Picks the speech-to-text engine. Local is the free default; cloud (OpenAI) is used when the
// user chose it and has a key, or as a stand-in while the local model is still downloading.
export type SttPref = 'local' | 'cloud-batch' | 'cloud-stream'
export type SttEngine = 'local' | 'cloud'

export interface SttAvailability {
  openaiKey: boolean
  localSupported: boolean
  localInstalled: boolean
}

export type SttDecision =
  | { engine: SttEngine }
  | { engine: null; reason: 'installing' | 'no-engine' }

export function chooseStt(pref: SttPref, a: SttAvailability): SttDecision {
  const localReady = a.localSupported && a.localInstalled
  if (pref !== 'local' && a.openaiKey) return { engine: 'cloud' }
  if (localReady) return { engine: 'local' }
  if (a.openaiKey) return { engine: 'cloud' }
  return { engine: null, reason: a.localSupported ? 'installing' : 'no-engine' }
}

/** The local model should be fetched: it is (or will be) the engine in use and is missing. */
export function wantsLocalModel(pref: SttPref, a: SttAvailability): boolean {
  return (pref === 'local' || !a.openaiKey) && a.localSupported && !a.localInstalled
}
