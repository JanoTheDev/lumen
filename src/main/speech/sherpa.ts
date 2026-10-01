// Main-thread side of the sherpa-onnx speech worker (wake-word spotter + offline STT). The
// native addon only loads inside the worker; main talks to it by message. A crashed worker is
// replaced on the next request, and listeners re-create the spotter it held.
import { existsSync } from 'fs'
import { sep } from 'path'
import { Worker } from 'worker_threads'
import { log } from '../logger'
import type { EngineEvent, EngineRequest } from './sherpa-engine'
import type { SpottedPhrase } from './wake/keywords'
import workerPath from './sherpa-worker?modulePath'

export interface SherpaWorker {
  postMessage(msg: EngineRequest, transfer?: ArrayBuffer[]): void
  on(event: 'message', cb: (e: EngineEvent) => void): unknown
  on(event: 'error', cb: (e: Error) => void): unknown
  on(event: 'exit', cb: (code: number) => void): unknown
  terminate(): unknown
}

const MAX_CRASHES = 3
const CRASH_WINDOW_MS = 60_000
const UNAVAILABLE = 'Offline speech engine is not available'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
type Request<R = Extract<EngineRequest, { id: number }>> = R extends unknown ? Omit<R, 'id'> : never

/** Prefers an unpacked copy of the worker script when the package ships one next to the asar. */
function workerFile(): string {
  const unpacked = workerPath.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  return unpacked !== workerPath && existsSync(unpacked) ? unpacked : workerPath
}

let createWorker = (): SherpaWorker => {
  const w = new Worker(workerFile(), { workerData: { sherpa: true } })
  w.unref()
  return w
}
let worker: SherpaWorker | null = null
let supported: boolean | undefined
let ready: Promise<boolean> | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let crashes: number[] = []
const hitListeners = new Set<(hits: SpottedPhrase[]) => void>()
const restartListeners = new Set<() => void>()

function failAll(error: Error): void {
  for (const p of pending.values()) p.reject(error)
  pending.clear()
}

function onCrash(w: SherpaWorker, why: string): void {
  if (worker !== w) return
  worker = null
  ready = null
  failAll(new Error(`speech engine stopped: ${why}`))
  const now = Date.now()
  crashes = [...crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
  if (crashes.length >= MAX_CRASHES) {
    supported = false
    log('fail', `speech engine crashed ${crashes.length} times in a minute; offline speech is off`)
  } else {
    log('fail', `speech engine stopped (${why}); restarting`)
  }
  for (const cb of restartListeners) cb()
}

function onEvent(w: SherpaWorker, e: EngineEvent, resolveReady: (ok: boolean) => void): void {
  if (worker !== w) return
  switch (e.t) {
    case 'ready':
      supported = e.supported
      if (!e.supported) {
        log('fail', `local speech engine unavailable: ${e.error ?? 'unknown error'}`)
        worker = null
        failAll(new Error(UNAVAILABLE))
        w.terminate()
      }
      return resolveReady(e.supported)
    case 'reply': {
      const p = pending.get(e.id)
      if (!p) return
      pending.delete(e.id)
      if (e.ok) p.resolve(e.value)
      else p.reject(new Error(e.error))
      return
    }
    case 'hits':
      for (const cb of hitListeners) cb(e.hits)
      return
    case 'log':
      return log(e.tag, e.message, e.timeMs !== undefined ? { timeMs: e.timeMs } : {})
  }
}

function ensureWorker(): SherpaWorker | null {
  if (supported === false) return null
  if (worker) return worker
  const w = createWorker()
  worker = w
  ready = new Promise<boolean>((resolve) => {
    w.on('message', (e) => onEvent(w, e, resolve))
    w.on('error', (err) => {
      resolve(false)
      onCrash(w, err.message)
    })
    w.on('exit', (code) => {
      resolve(false)
      onCrash(w, `exit code ${code}`)
    })
  })
  return w
}

/**
 * Starts the speech worker if needed. False once the native engine is known not to load on
 * this machine (it loads in the worker, so the first call returns true until it reports).
 */
export function loadSherpa(): boolean {
  ensureWorker()
  return supported !== false
}

/** Waits for the worker to report whether the native engine loads here. */
export function sherpaSupported(): Promise<boolean> {
  if (!ensureWorker()) return Promise.resolve(false)
  return ready ?? Promise.resolve(supported !== false)
}

/** One request/reply round trip to the worker. */
export function sherpaRequest<T>(msg: Request): Promise<T> {
  const w = ensureWorker()
  if (!w) return Promise.reject(new Error(UNAVAILABLE))
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    w.postMessage({ ...msg, id } as EngineRequest)
  })
}

/**
 * Mic audio for the spotter; dropped while no worker runs (no spotter to feed). Copied, not
 * transferred: 3.2 KB per block, and IPC buffers may not be detachable.
 */
export function sherpaFeed(pcm: ArrayBuffer): void {
  worker?.postMessage({ t: 'feed', pcm })
}

export function sherpaDropSpotter(): void {
  worker?.postMessage({ t: 'spotter-off' })
}

export function onSpotterHits(cb: (hits: SpottedPhrase[]) => void): () => void {
  hitListeners.add(cb)
  return () => hitListeners.delete(cb)
}

/** Called after a crashed worker was dropped; the next request starts a fresh one unless it
 * crashed too often (then loadSherpa() is false). */
export function onSherpaRestart(cb: () => void): () => void {
  restartListeners.add(cb)
  return () => restartListeners.delete(cb)
}

/** Tests: swap the worker (e.g. the engine in-thread) and reset all state. */
export function setSherpaWorkerFactory(factory: () => SherpaWorker): void {
  worker?.terminate()
  createWorker = factory
  worker = null
  ready = null
  supported = undefined
  crashes = []
  failAll(new Error('reset'))
}
