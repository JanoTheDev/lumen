// Lesson recorder renderer (07 T30): a hidden window that exists only while a lesson recording
// starts or runs. It captures the one screen main picked (no audio) with MediaRecorder and
// sends the webm file to main in pieces, in order, about one a second. Nothing is drawn,
// stored or sent anywhere else.

const lumen = window.lumen

const MIME_TYPES = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']

let recorder: MediaRecorder | null = null
let stopAsked = false
/** Pieces go out one after another, even though reading a Blob is async. */
let queue: Promise<void> = Promise.resolve()

function fail(e: unknown): void {
  const error = e instanceof Error ? e.message : String(e)
  lumen.send('recorder:status', { state: 'error', error: error.slice(0, 300) })
}

async function start(): Promise<void> {
  const cfg = await lumen.invoke('recorder:begin')
  if (!cfg) return
  // Chromium's desktop capture constraints (Electron desktopCapturer source id).
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: cfg.sourceId,
        maxWidth: cfg.maxWidth,
        maxHeight: cfg.maxHeight,
        maxFrameRate: cfg.fps
      }
    }
  } as unknown as MediaStreamConstraints
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  if (stopAsked) {
    for (const t of stream.getTracks()) t.stop()
    lumen.send('recorder:status', { state: 'stopped' })
    return
  }
  const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t))
  const rec = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: cfg.bitsPerSecond
  })
  recorder = rec
  rec.ondataavailable = (e) => {
    if (!e.data.size) return
    const blob = e.data
    queue = queue.then(async () => {
      lumen.send('recorder:chunk', new Uint8Array(await blob.arrayBuffer()))
    })
  }
  rec.onstop = () => {
    for (const t of stream.getTracks()) t.stop()
    void queue.then(() => lumen.send('recorder:status', { state: 'stopped' }))
  }
  rec.onerror = (e) => fail((e as Event & { error?: Error }).error ?? 'recording failed')
  // The screen went away (display unplugged): finish what was recorded.
  for (const track of stream.getVideoTracks())
    track.addEventListener('ended', () => {
      if (rec.state !== 'inactive') rec.stop()
    })
  rec.start(1000)
  lumen.send('recorder:status', { state: 'running' })
}

lumen.on('recorder:stop', () => {
  stopAsked = true
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  else if (!recorder) lumen.send('recorder:status', { state: 'stopped' })
})

start().catch(fail)
