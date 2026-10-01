// Face-gesture files (11 T25), downloaded the first time the feature is set up instead of
// shipping in the installer: the Face Landmarker model and the MediaPipe vision wasm. Both
// are Apache-2.0. Each is pinned by URL and SHA-256; the wasm must match the
// @mediapipe/tasks-vision version bundled in the face renderer (its loader script).
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { download } from '../downloads/verified-download'

/** Bump with the @mediapipe/tasks-vision version in package.json. */
export const TASKS_VISION_VERSION = '1.0.1'

export const FACE_HOSTS: readonly string[] = ['storage.googleapis.com', 'cdn.jsdelivr.net']

export interface FaceFile {
  name: string
  url: string
  sha256: string
  bytes: number
}

export const FACE_FILES: readonly FaceFile[] = [
  {
    name: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    bytes: 3_758_596
  },
  {
    name: 'vision_wasm_internal.wasm',
    url: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm/vision_wasm_internal.wasm`,
    sha256: '8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886',
    bytes: 11_756_954
  }
]

export const FACE_TOTAL_BYTES = FACE_FILES.reduce((n, f) => n + f.bytes, 0)

let baseDir: string | null = null

/** Overrides the folder (tests). */
export function setFaceDir(dir: string | null): void {
  baseDir = dir
}

export function faceDir(): string {
  return baseDir ?? join(homedir(), '.ai-overlay', 'face-model', TASKS_VISION_VERSION)
}

export function faceInstalled(): boolean {
  return FACE_FILES.every((f) => existsSync(join(faceDir(), f.name)))
}

/** Downloads the missing files; `onProgress` gets 0..100 over both. */
export async function installFaceFiles(
  onProgress: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  let done = 0
  for (const f of FACE_FILES) {
    const dest = join(faceDir(), f.name)
    if (!existsSync(dest)) {
      await download({
        url: f.url,
        sha256: f.sha256,
        dest,
        hosts: FACE_HOSTS,
        signal,
        onProgress: (bytes) =>
          onProgress(Math.min(100, Math.floor(((done + bytes) / FACE_TOTAL_BYTES) * 100)))
      })
    }
    done += f.bytes
    onProgress(Math.floor((done / FACE_TOTAL_BYTES) * 100))
  }
}

/** The files as bytes for the face renderer. */
export function readFaceFiles(): { wasm: Uint8Array; model: Uint8Array } {
  const dir = faceDir()
  return {
    model: new Uint8Array(readFileSync(join(dir, 'face_landmarker.task'))),
    wasm: new Uint8Array(readFileSync(join(dir, 'vision_wasm_internal.wasm')))
  }
}
