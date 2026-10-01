// Face-gesture renderer (11 T25): a hidden window that exists only while face gestures are
// on. It opens the camera, runs MediaPipe Face Landmarker on about 15 frames a second and
// sends main a handful of numbers per frame (FaceFrame). Frames are never drawn, stored or
// sent: each one is dropped as soon as its landmarks are read. Closing the window (feature
// off) stops the camera.
//
// The wasm binary and the model arrive from main as bytes (downloaded on first use and
// checked against a pinned SHA-256), so nothing is fetched: connect-src stays 'self', which
// also blocks the library's usage-metrics upload.
import { FaceLandmarker } from '@mediapipe/tasks-vision'
import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import { NO_FACE, toFrame } from './scores'

const FPS = 15

const lumen = window.lumen

function fail(e: unknown): void {
  const error = e instanceof Error ? e.message : String(e)
  lumen.send('face:status', { state: 'error', error: error.slice(0, 300) })
}

async function start(): Promise<void> {
  const assets = await lumen.invoke('face:assets')
  if (!assets.ok) throw new Error(assets.error)
  // Emscripten takes the binary from Module.wasmBinary instead of fetching it.
  const scope = self as unknown as { Module?: object }
  scope.Module = { wasmBinary: assets.wasm }
  const landmarker = await FaceLandmarker.createFromOptions(
    {
      wasmLoaderPath: new URL(loaderUrl, location.href).href,
      wasmBinaryPath: 'vision_wasm_internal.wasm'
    },
    {
      baseOptions: { modelAssetBuffer: assets.model, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true
    }
  )

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(assets.cameraId ? { deviceId: { exact: assets.cameraId } } : {}),
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: FPS, max: 30 }
    }
  })
  // Never attached to the page: it only feeds the landmarker.
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  await video.play()
  lumen.send('face:status', { state: 'running' })

  let last = -1
  const timer = setInterval(() => {
    if (video.readyState < 2) return
    const now = performance.now()
    if (now <= last) return
    last = now
    try {
      const r = landmarker.detectForVideo(video, now)
      const shapes = r.faceBlendshapes?.[0]?.categories
      const matrix = r.facialTransformationMatrixes?.[0]?.data
      lumen.send('face:frame', shapes ? toFrame(shapes, matrix) : NO_FACE)
    } catch (e) {
      fail(e)
    }
  }, 1000 / FPS)

  for (const track of stream.getVideoTracks()) {
    track.addEventListener('ended', () => {
      clearInterval(timer)
      fail(new Error('The camera stopped.'))
    })
  }
  window.addEventListener('beforeunload', () => {
    clearInterval(timer)
    for (const t of stream.getTracks()) t.stop()
    landmarker.close()
  })
}

start().catch(fail)
