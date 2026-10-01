// Windows voices as audio data. A long-lived PowerShell process runs the WinRT
// SpeechSynthesizer (the same OneCore voices speechSynthesis lists) and returns WAV per
// sentence, so the voice renderer can play it through WebAudio, where Chromium's echo
// cancellation hears it (barge-in). The same process reads and clears the output mute
// (muted-output fallback). Started on first use, stopped after a few idle minutes.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { WIN_HELPER_SCRIPT } from './win-script'

export interface WinVoice {
  id: string
  name: string
  lang: string
}

export interface OutputState {
  muted: boolean
  /** 0..1 master volume of the default playback device. */
  volume: number
}

type Reply = { id: number; ok: boolean; error?: string } & Record<string, unknown>

export type HelperSpawn = (script: string) => ChildProcessWithoutNullStreams

export interface WinHelperOptions {
  spawn?: HelperSpawn
  idleMs?: number
  /** Spawns that died before answering in a row before the helper gives up for the session. */
  maxFailures?: number
}

const SYNTH_TIMEOUT_MS = 15_000
const IDLE_MS = 5 * 60_000

function defaultSpawn(script: string): ChildProcessWithoutNullStreams {
  // -EncodedCommand keeps the script off disk; it is UTF-16LE base64 by definition.
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: 'pipe' }
  )
}

/**
 * The installed voice for a configured name. Chromium lists "Microsoft David - English (United
 * States)" where WinRT says "Microsoft David", so a prefix match counts. Else the first English
 * voice, else the first one (null = the system default).
 */
export function pickWinVoice(voices: readonly WinVoice[], name: string): WinVoice | null {
  const want = name.trim().toLowerCase()
  if (want) {
    const exact = voices.find((v) => v.name.toLowerCase() === want)
    if (exact) return exact
    const prefixed = voices
      .filter((v) => want.startsWith(v.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (prefixed) return prefixed
  }
  return voices.find((v) => v.lang.toLowerCase().startsWith('en')) ?? voices[0] ?? null
}

/** WinRT SpeakingRate range is 0.5–6. */
export function winRate(rate: number): number {
  return Math.max(0.5, Math.min(6, Number.isFinite(rate) ? rate : 1))
}

export class WinVoiceHelper {
  private child: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private seq = 0
  private pending = new Map<
    number,
    {
      resolve: (r: Reply) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private answered = false
  private voiceList: Promise<WinVoice[]> | null = null
  private readonly spawnFn: HelperSpawn
  private readonly idleMs: number
  private readonly maxFailures: number
  private readonly platformOk: boolean

  constructor(opts: WinHelperOptions = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn
    this.idleMs = opts.idleMs ?? IDLE_MS
    this.maxFailures = opts.maxFailures ?? 3
    this.platformOk = !!opts.spawn || process.platform === 'win32'
  }

  /** False after repeated start failures (no PowerShell, WinRT blocked): use speechSynthesis. */
  get usable(): boolean {
    return this.platformOk && this.failures < this.maxFailures
  }

  /** WAV bytes (base64) for one sentence. */
  async synth(text: string, voiceName: string, rate: number): Promise<string> {
    const voice = pickWinVoice(await this.voices(), voiceName)
    const r = await this.request(
      {
        op: 'synth',
        text: Buffer.from(text, 'utf8').toString('base64'),
        voiceId: voice?.id ?? '',
        rate: winRate(rate)
      },
      SYNTH_TIMEOUT_MS
    )
    if (typeof r.wav !== 'string' || !r.wav) throw new Error('no audio')
    return r.wav
  }

  voices(): Promise<WinVoice[]> {
    if (!this.voiceList) {
      this.voiceList = this.request({ op: 'voices' }, SYNTH_TIMEOUT_MS)
        .then((r) => (Array.isArray(r.voices) ? (r.voices as WinVoice[]) : []))
        .catch((e) => {
          this.voiceList = null
          throw e
        })
    }
    return this.voiceList
  }

  async outputState(timeoutMs: number): Promise<OutputState> {
    const r = await this.request({ op: 'output' }, timeoutMs)
    return { muted: r.muted === true, volume: typeof r.volume === 'number' ? r.volume : 1 }
  }

  async unmute(): Promise<void> {
    await this.request({ op: 'unmute' }, 5000)
  }

  /** Starts the process ahead of the first sentence (it takes about a second). */
  warm(): void {
    if (!this.usable) return
    // The output check compiles its interop on first use; do that now, not before an answer.
    void this.voices()
      .then(() => this.outputState(10_000))
      .catch(() => {})
  }

  dispose(): void {
    this.kill(new Error('stopped'))
  }

  private request(body: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    if (!this.usable) return Promise.reject(new Error('Windows voice helper unavailable'))
    const child = this.ensure()
    const id = ++this.seq
    this.touch()
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${String(body.op)} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, ...body }) + '\n')
    }).then((r) => {
      if (!r.ok) throw new Error(r.error || `${String(body.op)} failed`)
      return r
    })
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child
    const child = this.spawnFn(WIN_HELPER_SCRIPT)
    this.child = child
    this.buf = ''
    this.answered = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => this.onData(d))
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {})
    const gone = (why: string): void => {
      if (this.child !== child) return
      this.child = null
      this.voiceList = null
      if (!this.answered) this.failures++
      this.rejectAll(new Error(why))
    }
    child.on('error', (e) => gone(e.message))
    child.on('exit', (code) => gone(`voice helper exited (${code})`))
    return child
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let reply: Reply
      try {
        reply = JSON.parse(line) as Reply
      } catch {
        continue
      }
      this.answered = true
      this.failures = 0
      const p = this.pending.get(reply.id)
      if (!p) continue
      this.pending.delete(reply.id)
      clearTimeout(p.timer)
      p.resolve(reply)
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.pending.size === 0) this.kill(new Error('idle'))
      else this.touch()
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private kill(err: Error): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const child = this.child
    this.child = null
    this.voiceList = null
    this.rejectAll(err)
    if (child) {
      child.stdin.end()
      child.kill()
    }
  }
}
