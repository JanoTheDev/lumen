// Vosk small English model for the agent's fallback wake-word listener, installed once to
// ~/.ai-overlay/vosk-model/ (a folder containing am/, conf/, graph/) via the verified downloader.
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { broadcast as broadcastToWindows } from './windows/registry'
import { log } from './logger'
import {
  installArchive,
  type ArchiveSpec,
  type DownloadProgress
} from './downloads/verified-download'

const MODEL_NAME = 'vosk-model-small-en-us-0.15'

export const VOSK_MODEL: ArchiveSpec = {
  url: `https://alphacephei.com/vosk/models/${MODEL_NAME}.zip`,
  // Computed from the official download on 2026-10-01 (41,205,931 bytes).
  sha256: '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498',
  rootInArchive: MODEL_NAME,
  requiredFiles: ['am/final.mdl', 'conf/model.conf', 'graph/HCLr.fst']
}

export function modelRoot(): string {
  return join(homedir(), '.ai-overlay', 'vosk-model')
}

export function modelInstalled(): boolean {
  const root = modelRoot()
  if (!existsSync(root)) return false
  try {
    return readdirSync(root).includes('am')
  } catch {
    return false
  }
}

export type ProgressEvent = DownloadProgress

let installing: Promise<void> | null = null

/** Downloads and unpacks the model once; concurrent callers share the install. */
export function installModel(): Promise<void> {
  if (modelInstalled()) {
    broadcastToWindows('wake:model-progress', { phase: 'done' })
    return Promise.resolve()
  }
  if (installing) return installing
  log('step', 'downloading Vosk model')
  const report = (p: DownloadProgress): void => broadcastToWindows('wake:model-progress', p)
  installing = installArchive(VOSK_MODEL, modelRoot(), report)
    .then(() => log('done', `Vosk model installed at ${modelRoot()}`))
    .catch((e: Error) => {
      log('fail', `Vosk model install failed: ${e.message}`)
      report({ phase: 'error', message: e.message })
      throw e
    })
    .finally(() => {
      installing = null
    })
  return installing
}
