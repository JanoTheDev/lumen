// The one microphone stream of the voice renderer. Recording and the wake-word feed share it,
// so the mic opens once. Holders keep it open; without holders it is released after a while
// so the OS mic indicator turns off.

const IDLE_RELEASE_MS = 10000

let stream: MediaStream | null = null
let opening: Promise<MediaStream> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
const holders = new Set<string>()

function live(s: MediaStream | null): s is MediaStream {
  return !!s && s.getTracks().length > 0 && s.getTracks().every((t) => t.readyState === 'live')
}

/** The shared stream, opened on first use. Echo cancellation keeps spoken replies out. */
export async function getMicStream(): Promise<MediaStream> {
  if (live(stream)) return stream
  if (opening) return opening
  opening = navigator.mediaDevices
    .getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    .then((s) => {
      stream = s
      return s
    })
    .finally(() => {
      opening = null
    })
  return opening
}

function release(): void {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

/** Keeps the stream open for `who` until dropMic(who). */
export function holdMic(who: string): void {
  holders.add(who)
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

/** Lets go of the stream; it closes after the idle delay if nobody else holds it. */
export function dropMic(who: string, delayMs = IDLE_RELEASE_MS): void {
  holders.delete(who)
  if (holders.size > 0) return
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (holders.size === 0) release()
  }, delayMs)
}

/** Closes the stream now, whoever holds it (window teardown). */
export function closeMic(): void {
  holders.clear()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  release()
}
