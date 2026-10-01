// First-run checks for the setup flow: is everything Lumen needs on this PC working, and if
// not, what one click can fix. Pure logic over injected probes; ipc.ts supplies the real ones.
import type { FirstRunCheck, FirstRunCheckId } from '@shared/channels'

export const CHECK_IDS = [
  'keys',
  'microphone',
  'agent',
  'hotkey',
  'ocr',
  'wake-model',
  'elevation'
] as const satisfies readonly FirstRunCheckId[]

export const HOTKEY_TEST_MS = 20_000

export const SETTINGS_URI = {
  microphone: 'ms-settings:privacy-microphone',
  language: 'ms-settings:regionlanguage'
} as const

export interface AgentView {
  running: boolean
  impl: string | null
  version: string | null
  fallback: string | null
}

export interface CheckProbes {
  keyProviders: () => string[]
  localMode: () => boolean
  micAccess: () => string
  agent: () => AgentView | null
  hotkey: () => string
  /** Resolves true when the assistant hotkey is pressed within `ms`. */
  waitForHotkey: (ms: number) => Promise<boolean>
  /** OCR on a small screen region; throws with `code` on failure. */
  ocr: () => Promise<void>
  wakeEnabled: () => boolean
  wakeModelInstalled: () => boolean
  wakeModelSizeMb: () => number
  installWakeModel: () => Promise<void>
  restartAgent: () => Promise<void>
  elevated: () => Promise<boolean>
  openUri: (uri: string) => Promise<void>
}

const check = (
  id: FirstRunCheckId,
  status: FirstRunCheck['status'],
  message: string,
  fixAction?: string
): FirstRunCheck => (fixAction ? { id, status, message, fixAction } : { id, status, message })

function keysCheck(p: CheckProbes): FirstRunCheck {
  const providers = p.keyProviders()
  if (providers.length) return check('keys', 'ok', `AI key set (${providers.join(', ')}).`)
  if (p.localMode()) return check('keys', 'ok', 'Local mode: no AI key needed.')
  return check('keys', 'fail', 'No AI key yet. Paste an Anthropic or OpenAI key to continue.')
}

function micCheck(p: CheckProbes): FirstRunCheck {
  const access = p.micAccess()
  if (access === 'denied' || access === 'restricted') {
    return check(
      'microphone',
      'fail',
      'Windows is blocking the microphone for desktop apps.',
      'Open microphone settings'
    )
  }
  return check('microphone', 'ok', 'Microphone access is allowed.')
}

function agentCheck(p: CheckProbes): FirstRunCheck {
  const a = p.agent()
  if (!a || !a.running) {
    return check('agent', 'fail', 'The Lumen helper is not running.', 'Restart the helper')
  }
  if (a.impl === 'python' && a.fallback) {
    return check('agent', 'warn', `Using the backup helper: ${a.fallback}.`)
  }
  const name = a.impl === 'native' ? 'Lumen helper' : 'Helper'
  return check('agent', 'ok', `${name} running${a.version ? ` (version ${a.version})` : ''}.`)
}

function wakeCheck(p: CheckProbes): FirstRunCheck {
  if (!p.wakeEnabled()) return check('wake-model', 'ok', 'Wake word is off.')
  if (p.wakeModelInstalled()) return check('wake-model', 'ok', 'Wake word model installed.')
  return check(
    'wake-model',
    'warn',
    `The wake word needs a one-time ${p.wakeModelSizeMb()} MB download.`,
    'Download'
  )
}

const pendingHotkey = (p: CheckProbes): FirstRunCheck =>
  check('hotkey', 'pending', `Press ${p.hotkey()} to test the hotkey.`)

const pendingOcr = (): FirstRunCheck =>
  check('ocr', 'pending', 'Not checked yet: reading text on the screen.')

const pendingElevation = (): FirstRunCheck =>
  check('elevation', 'pending', 'Not checked yet: admin rights.')

/** Every check without slow or interactive probes (hotkey, OCR, elevation stay pending). */
export function listChecks(p: CheckProbes): FirstRunCheck[] {
  return [
    keysCheck(p),
    micCheck(p),
    agentCheck(p),
    pendingHotkey(p),
    pendingOcr(),
    wakeCheck(p),
    pendingElevation()
  ]
}

export async function runCheck(id: FirstRunCheckId, p: CheckProbes): Promise<FirstRunCheck> {
  switch (id) {
    case 'keys':
      return keysCheck(p)
    case 'microphone':
      return micCheck(p)
    case 'agent':
      return agentCheck(p)
    case 'wake-model':
      return wakeCheck(p)
    case 'hotkey': {
      const pressed = await p.waitForHotkey(HOTKEY_TEST_MS)
      return pressed
        ? check('hotkey', 'ok', `${p.hotkey()} works.`)
        : check(
            'hotkey',
            'fail',
            `No press of ${p.hotkey()} came through. Another app may use it; pick a different hotkey in Settings.`
          )
    }
    case 'ocr':
      try {
        await p.ocr()
        return check('ocr', 'ok', 'Lumen can read text on the screen.')
      } catch (e) {
        if ((e as { code?: string }).code === 'E_UNSUPPORTED') {
          return check(
            'ocr',
            'fail',
            'Windows has no text recognition for your language. Add an English language pack.',
            'Open language settings'
          )
        }
        return check('ocr', 'warn', `Reading the screen failed: ${(e as Error).message}`)
      }
    case 'elevation':
      return (await p.elevated())
        ? check(
            'elevation',
            'warn',
            'Lumen is running as administrator. It does not need to; start it normally.'
          )
        : check(
            'elevation',
            'ok',
            'Runs without admin. Apps running as administrator cannot be controlled.'
          )
  }
}

export async function fixCheck(
  id: FirstRunCheckId,
  p: CheckProbes
): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (id) {
      case 'microphone':
        await p.openUri(SETTINGS_URI.microphone)
        return { ok: true }
      case 'ocr':
        await p.openUri(SETTINGS_URI.language)
        return { ok: true }
      case 'wake-model':
        await p.installWakeModel()
        return { ok: true }
      case 'agent':
        await p.restartAgent()
        return { ok: true }
      default:
        return { ok: false, error: 'Nothing to fix automatically.' }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
