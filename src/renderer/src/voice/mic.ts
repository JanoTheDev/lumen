// The one microphone stream of the voice renderer. Recording and the wake-word feed share it,
// so the mic opens once. Holders keep it open; without holders it is released after a while
// so the OS mic indicator turns off.

const IDLE_RELEASE_MS = 10000

let stream: MediaStream | null = null
/** Chosen input (config voice.micDeviceId); '' = system default. */
let deviceId = ''
let streamDevice = ''
const changeListeners = new Set<() => void>()
let opening: Promise<MediaStream> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
const holders = new Set<string>()

function live(s: MediaStream | null): s is MediaStream {
  return !!s && s.getTracks().length > 0 && s.getTracks().every((t) => t.readyState === 'live')
}

/** Mic constraints; echo cancellation keeps spoken replies out. */
export function micConstraints(device: string): MediaTrackConstraints {
  return {
    ...(device ? { deviceId: { exact: device } } : {}),
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
}

async function openStream(device: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(device) })
  } catch (err) {
    // The chosen mic is gone (unplugged, renamed): fall back to the default one.
    const name = (err as { name?: string })?.name
    if (!device || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw err
    console.warn('[mic] chosen microphone unavailable, using the default')
    return navigator.mediaDevices.getUserMedia({ audio: micConstraints('') })
  }
}

/** The shared stream, opened on first use. */
export async function getMicStream(): Promise<MediaStream> {
  if (live(stream) && streamDevice === deviceId) return stream
  if (opening) return opening
  const device = deviceId
  // A stream on the previous device (switch deferred during a recording) is replaced.
  const stale = !!stream
  if (stale) release()
  opening = openStream(device)
    .then((s) => {
      stream = s
      streamDevice = device
      watchUnplug(s)
      return s
    })
    .finally(() => {
      opening = null
    })
  const pending = opening
  if (stale) notifyChanged()
  return pending
}

/**
 * The microphone went away (unplugged, disabled): drop the dead stream so the next use opens
 * the default one, and say so. A recording in progress ends and sends what it has.
 */
function watchUnplug(s: MediaStream): void {
  for (const track of s.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (stream !== s) return
      console.warn('[mic] microphone disconnected')
      release()
      notifyChanged()
      try {
        window.lumen.send(
          'assistant:error',
          'Microphone disconnected. Using the default microphone.'
        )
      } catch {
        /* window closing */
      }
    })
  }
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
  if (who === 'record' && stream && streamDevice !== deviceId) switchNow()
  if (holders.size > 0) return
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (holders.size === 0) release()
  }, delayMs)
}

/** Called when the chosen microphone changes; stream users reopen (see the wake feed). */
export function onMicChanged(cb: () => void): () => void {
  changeListeners.add(cb)
  return () => changeListeners.delete(cb)
}

function notifyChanged(): void {
  for (const cb of changeListeners) cb()
}

function switchNow(): void {
  release()
  notifyChanged()
}

/**
 * Picks the input device. A running recording keeps its mic; the switch happens when it ends.
 */
export function setMicDevice(id: string): void {
  if (id === deviceId) return
  deviceId = id
  if (!stream || streamDevice === id) return
  if (!holders.has('record')) switchNow()
}

/** Follows config voice.micDeviceId; returns the cleanup. */
export function startMicDeviceSync(): () => void {
  const apply = (cfg: unknown): void => {
    const voice = (cfg as { voice?: { micDeviceId?: unknown } } | null)?.voice
    setMicDevice(typeof voice?.micDeviceId === 'string' ? voice.micDeviceId : '')
  }
  window.lumen
    .invoke('settings:get')
    .then(apply)
    .catch(() => {})
  return window.lumen.on('settings:changed', apply)
}

/** Closes the stream now, whoever holds it (window teardown). */
export function closeMic(): void {
  holders.clear()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  release()
}
