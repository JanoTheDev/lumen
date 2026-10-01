// Context awareness (04 T41, opt-in: dictation.screenNames, off by default). When dictation
// starts, the text of the focused window (UIA document text, the thread you are replying to)
// is read once, locally, and the names in it fix how dictated names are spelled ("Jon" →
// "John" when John is on screen, "github" → "GitHub"). The screen text never leaves the PC,
// is never stored or logged, and is dropped after the dictation. Private mode turns it off.
import type { AgentBridge } from '../../agent/bridge'
import { getAgent } from '../../agent/instance'
import { bus } from '../../bus'
import { loadConfig } from '../../config'
import { extractScreenNames, MAX_SCREEN_CHARS } from './names'

const READ_TIMEOUT_MS = 1500
/** How long dictate() waits for a read still running when the recording ended. */
const WAIT_MS = 400

let pending: Promise<string[]> | null = null

export function screenNamesWanted(): boolean {
  const cfg = loadConfig()
  return cfg.dictation.enabled && cfg.dictation.screenNames === true && !cfg.memory.privateMode
}

/** Reads the focused window's text through UIA and keeps only the names. */
export async function readScreenNames(agent: AgentBridge): Promise<string[]> {
  if (!agent.hasCapability('uia-text')) return []
  try {
    const [doc, focus] = await Promise.all([
      agent.request<Record<string, unknown>>(
        'uia_text',
        { scope: 'document', maxChars: MAX_SCREEN_CHARS },
        { timeoutMs: READ_TIMEOUT_MS }
      ),
      agent
        .request<Record<string, unknown>>('focus_info', {}, { timeoutMs: READ_TIMEOUT_MS })
        .catch(() => null)
    ])
    const source = String(doc?.source ?? '')
    if (source === 'password' || source === 'none') return []
    const title = String(focus?.title ?? '')
    return extractScreenNames(`${title}\n${String(doc?.text ?? '')}`)
  } catch {
    return []
  }
}

function start(): void {
  pending = null
  if (!screenNamesWanted()) return
  const agent = getAgent()
  if (!agent) return
  pending = readScreenNames(agent)
}

/** The names read when this recording started ([] when off or not ready in time). */
export async function takeScreenNames(): Promise<string[]> {
  const p = pending
  pending = null
  if (!p) return []
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<string[]>((r) => (timer = setTimeout(() => r([]), WAIT_MS)))
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

bus.on('dictation.started', start)
// The assistant hotkey only dictates through auto-detect.
bus.on('voice.started', () => (loadConfig().dictation.autoDetect ? start() : (pending = null)))
bus.on('voice.cancelled', () => (pending = null))
