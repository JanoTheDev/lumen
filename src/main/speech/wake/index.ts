// Wake word + voice-cancel engine. Default: sherpa-onnx keyword spotting here in main, fed by
// the voice renderer's mic stream (the same stream recording uses: one mic open, echo
// cancelled). Fallback: the agent's Vosk listener, when the spotter model is missing (and the
// Vosk model is already there) or the native engine does not load.
import { loadConfig, type AppConfig } from '../../config'
import { log } from '../../logger'
import { getAgent } from '../../agent/instance'
import { splitPhrases } from '../../agent/state'
import type { WakeStatus } from '@shared/channels'
import {
  installModel as installVoskModel,
  modelInstalled as voskInstalled,
  modelRoot as voskModelRoot
} from '../../wake-model'
import * as hud from '../../windows/hud'
import { broadcast } from '../../windows/registry'
import { loadSherpa } from '../sherpa'
import { localSttReady, transcribeLocal } from '../stt/local'
import { cancelArmed, onCancelArmed } from './arm'
import { confirmsCancel } from './confirm'
import { handleVoiceCancel, handleWake } from './handlers'
import { installKwsModel, KWS_MODEL, kwsModelDir, kwsModelInstalled } from './kws-model'
import type { KeywordPhrases } from './keywords'
import { Spotter } from './spotter'

export type WakeEngine = 'kws' | 'vosk' | 'off'

type Phrases = KeywordPhrases

const REFRACTORY_MS = 2000
// Audio after a cancel hit that goes into the confirming transcript ("stop" vs "stopwatch").
const CONFIRM_TAIL_MS = 300
const MAX_PCM_BYTES = 64_000
const VOSK_SIZE_MB = 40

let engine: WakeEngine = 'off'
let spotter: Spotter | null = null
let applySeq = 0
let lastWakeAt = 0
let confirming = false
let unusable: string[] = []

export function wakeEngine(): WakeEngine {
  return engine
}

/** Engine, model and phrase state for Settings. */
export function wakeStatus(): WakeStatus {
  const native = !!loadSherpa()
  return {
    installed: native ? kwsModelInstalled() : voskInstalled(),
    path: native ? kwsModelDir() : voskModelRoot(),
    engine,
    sizeMb: native ? KWS_MODEL.sizeMb : VOSK_SIZE_MB,
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

function syncAgentArm(): void {
  if (engine !== 'vosk') return
  getAgent()
    ?.request('wake_arm_cancel', { armed: cancelArmed() })
    .catch(() => {})
}

onCancelArmed(() => syncAgentArm())

function startVosk(p: Phrases): void {
  const enable = (): void => {
    getAgent()
      ?.enableListener(p.wake, p.cancel)
      .then(syncAgentArm)
      .catch((e) => console.error('[listener] enable failed:', (e as Error).message))
  }
  if (voskInstalled()) return enable()
  installVoskModel()
    .then(enable)
    .catch((e) => console.error('[listener] model install failed:', (e as Error).message))
}

function switchTo(next: WakeEngine, p?: Phrases): void {
  if (next !== 'kws') {
    spotter = null
    unusable = []
  }
  if (next !== engine) log('step', `wake engine: ${next}`)
  engine = next
  hud.send('voice:wake-listen', next === 'kws')
  if (next === 'vosk' && p) startVosk(p)
  else
    getAgent()
      ?.disableListener()
      .catch(() => {})
  broadcast('wake:status', wakeStatus())
}

/** Applies the wake/cancel settings; re-run after config changes and agent restarts. */
export function applyWakeState(cfg: AppConfig): void {
  const seq = ++applySeq
  const p = phrasesOf(cfg)
  if (!p.wake && !p.cancel.length) return switchTo('off')

  const lib = loadSherpa()
  if (lib && kwsModelInstalled()) {
    try {
      const next = new Spotter(lib, kwsModelDir(), p)
      for (const phrase of next.unusable)
        log('fail', `wake: "${phrase}" can't be spelled by the model`)
      spotter = next
      unusable = next.unusable
      return switchTo('kws')
    } catch (e) {
      log('fail', `wake word spotter failed, using Vosk: ${(e as Error).message}`)
    }
  } else if (lib) {
    installKwsModel()
      .then(() => {
        if (seq === applySeq) applyWakeState(loadConfig())
      })
      .catch(() => {})
    // The spotter is on its way (18 MB): only use Vosk meanwhile if it is already installed.
    if (!voskInstalled()) return switchTo('off')
  }
  switchTo('vosk', p)
}

async function confirmCancel(phrase: string): Promise<void> {
  if (confirming) return
  confirming = true
  try {
    await new Promise((r) => setTimeout(r, CONFIRM_TAIL_MS))
    const audio = spotter?.recentAudio()
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
  if (engine !== 'kws' || !spotter) return
  if (!(raw instanceof ArrayBuffer) || raw.byteLength > MAX_PCM_BYTES || raw.byteLength % 2) return
  for (const hit of spotter.feed(new Int16Array(raw))) {
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
