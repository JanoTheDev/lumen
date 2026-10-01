// Wake word + voice-cancel engine: sherpa-onnx keyword spotting in the speech worker, fed by
// the voice renderer's mic stream (the same stream recording uses: one mic open, echo
// cancelled). When the engine cannot load, the wake word reports itself unavailable.
import { loadConfig, type AppConfig } from '../../config'
import { log } from '../../logger'
import { splitPhrases } from '../../agent/state'
import type { WakeStatus } from '@shared/channels'
import * as hud from '../../windows/hud'
import { broadcast } from '../../windows/registry'
import {
  loadSherpa,
  onSherpaRestart,
  onSpotterHits,
  sherpaDropSpotter,
  sherpaFeed,
  sherpaRequest
} from '../sherpa'
import type { SpotterBuilt } from '../sherpa-engine'
import { localSttReady, transcribeLocal } from '../stt/local'
import { cancelArmed } from './arm'
import { confirmsCancel } from './confirm'
import { handleVoiceCancel, handleWake } from './handlers'
import { installKwsModel, KWS_MODEL, kwsModelDir, kwsModelInstalled } from './kws-model'
import type { KeywordPhrases, SpottedPhrase } from './keywords'

export type WakeEngine = 'kws' | 'off'

type Phrases = KeywordPhrases

const REFRACTORY_MS = 2000
// Audio after a cancel hit that goes into the confirming transcript ("stop" vs "stopwatch").
const CONFIRM_TAIL_MS = 300
const MAX_PCM_BYTES = 64_000

export const ENGINE_UNAVAILABLE = 'The offline wake word engine could not load on this PC.'

let engine: WakeEngine = 'off'
/** Phrases + sensitivity the current spotter was built for; unchanged settings reuse it. */
let spotterKey = ''
let applySeq = 0
let lastWakeAt = 0
let confirming = false
let unusable: string[] = []
let spotterError: string | null = null

/** Engine, model and phrase state for Settings. */
export function wakeStatus(): WakeStatus {
  return {
    installed: kwsModelInstalled(),
    path: kwsModelDir(),
    engine,
    unavailable: loadSherpa() ? spotterError : ENGINE_UNAVAILABLE,
    sizeMb: KWS_MODEL.sizeMb,
    unusable: [...unusable]
  }
}

/** The voice renderer should stream mic audio here. */
export function wakeFeedWanted(): boolean {
  return engine === 'kws'
}

function phrasesOf(cfg: AppConfig): Phrases {
  const phrase = cfg.wakeWord.phrase.trim()
  return {
    wake: cfg.wakeWord.enabled ? phrase : '',
    cancel: cfg.cancelVoice.enabled ? splitPhrases(cfg.cancelVoice.phrases) : [],
    sensitivity: cfg.wakeWord.sensitivity
  }
}

function switchTo(next: WakeEngine): void {
  if (next !== 'kws') {
    if (spotterKey) sherpaDropSpotter()
    spotterKey = ''
    unusable = []
  }
  if (next !== engine) log('step', `wake engine: ${next}`)
  engine = next
  hud.send('voice:wake-listen', next === 'kws')
  broadcast('wake:status', wakeStatus())
}

/** Applies the wake/cancel settings; re-run after config changes. */
export function applyWakeState(cfg: AppConfig): void {
  const seq = ++applySeq
  const p = phrasesOf(cfg)
  spotterError = null
  if (!p.wake && !p.cancel.length) return switchTo('off')

  if (!loadSherpa()) {
    log('fail', 'wake word unavailable: the sherpa-onnx engine did not load')
    return switchTo('off')
  }
  if (!kwsModelInstalled()) {
    installKwsModel()
      .then(() => {
        if (seq === applySeq) applyWakeState(loadConfig())
      })
      .catch(() => {})
    return switchTo('off')
  }
  const key = JSON.stringify(p)
  if (engine === 'kws' && key === spotterKey) return switchTo('kws')
  // The worker keeps feeding the previous spotter (if any) until this one is built.
  sherpaRequest<SpotterBuilt>({ t: 'spotter', dir: kwsModelDir(), phrases: p }).then(
    (built) => {
      if (seq !== applySeq) return
      for (const phrase of built.unusable)
        log('fail', `wake: "${phrase}" can't be spelled by the model`)
      spotterKey = key
      unusable = built.unusable
      switchTo('kws')
    },
    (e: Error) => {
      if (seq !== applySeq) return
      spotterError = `The wake word spotter failed to start: ${e.message}`
      log('fail', spotterError)
      switchTo('off')
    }
  )
}

// A crashed worker took its spotter with it: build a new one (or report the engine gone).
onSherpaRestart(() => {
  if (!spotterKey) return
  spotterKey = ''
  applyWakeState(loadConfig())
})

async function confirmCancel(phrase: string): Promise<void> {
  if (confirming) return
  confirming = true
  try {
    await new Promise((r) => setTimeout(r, CONFIRM_TAIL_MS))
    const audio = await sherpaRequest<Float32Array | null>({ t: 'recent' })
    if (!audio || !cancelArmed()) return
    if (!localSttReady()) return handleVoiceCancel(phrase)
    const text = await transcribeLocal(audio, 16000)
    if (!cancelArmed()) return
    if (confirmsCancel(text, phrase)) handleVoiceCancel(phrase)
    else log('step', `cancel "${phrase}" not confirmed by transcript "${text}"`)
  } catch (e) {
    // Cancelling is the safe side when the check itself fails.
    log('fail', `cancel confirmation failed: ${(e as Error).message}`)
    handleVoiceCancel(phrase)
  } finally {
    confirming = false
  }
}

/** 16 kHz mono Int16 audio from the voice renderer. */
export function onWakePcm(raw: unknown): void {
  if (engine !== 'kws') return
  if (!(raw instanceof ArrayBuffer) || raw.byteLength > MAX_PCM_BYTES || raw.byteLength % 2) return
  sherpaFeed(raw)
}

onSpotterHits(onHits)

function onHits(hits: SpottedPhrase[]): void {
  if (engine !== 'kws') return
  for (const hit of hits) {
    if (hit.kind === 'wake') {
      const now = Date.now()
      if (now - lastWakeAt < REFRACTORY_MS) continue
      lastWakeAt = now
      handleWake('kws')
    } else if (cancelArmed()) {
      void confirmCancel(hit.phrase)
    }
  }
}
