// OBS bridge (07 T24): read-only obs-websocket v5 requests turned into a flat state for the
// check DSL. One connection, kept open while it works; a failed connect waits 3 s before the
// next try so 1 Hz checks do not hammer a closed OBS.
import type { BridgeStatus } from '@shared/channels'
import type { BridgeState } from './expect'
import {
  ObsError,
  connectObs,
  type ObsConnection,
  type ObsErrorCode,
  type WsFactory
} from './obs-client'
import type { AppBridge } from './types'

const RETRY_MS = 3000

type Data = Record<string, unknown>
const names = (list: unknown, key: string): string[] =>
  Array.isArray(list)
    ? list.map((x) => (x as Data)?.[key]).filter((v): v is string => typeof v === 'string')
    : []

/** The only requests a lesson may ask, each mapped to the keys its `expect` uses. */
export const OBS_REQUESTS: Record<string, (d: Data) => BridgeState> = {
  GetRecordStatus: (d) => ({ outputActive: d.outputActive, outputPaused: d.outputPaused }),
  GetRecordDirectory: (d) => ({ recordDirectory: d.recordDirectory }),
  GetCurrentProgramScene: (d) => ({ sceneName: d.sceneName ?? d.currentProgramSceneName }),
  GetSceneList: (d) => ({
    sceneName: d.currentProgramSceneName,
    scenes: names(d.scenes, 'sceneName')
  }),
  GetInputList: (d) => ({
    inputs: names(d.inputs, 'inputName'),
    inputKinds: [
      ...new Set([...names(d.inputs, 'inputKind'), ...names(d.inputs, 'unversionedInputKind')])
    ]
  })
}

export interface ObsSettings {
  port: number
  password?: string
}

const DETAIL: Record<ObsErrorCode, string> = {
  unreachable:
    'OBS is closed, or its WebSocket server is off (Tools, WebSocket Server Settings, Enable).',
  'password-needed': 'OBS asks for a password. Paste the one from WebSocket Server Settings.',
  'auth-failed': 'OBS did not accept the password. Copy it again from Show Connect Info.',
  timeout: 'OBS did not answer in time.',
  closed: 'OBS closed the connection.'
}

export interface ObsBridge extends AppBridge {
  /** Drops the connection (settings changed). */
  reset(): void
}

export function obsBridge(settings: () => ObsSettings, ws?: WsFactory): ObsBridge {
  let conn: ObsConnection | null = null
  let connecting: Promise<ObsConnection> | null = null
  let retryAt = 0

  const connection = (force = false): Promise<ObsConnection> => {
    if (conn?.open) return Promise.resolve(conn)
    if (connecting) return connecting
    if (!force && Date.now() < retryAt) return Promise.reject(new ObsError('unreachable'))
    const s = settings()
    connecting = connectObs({ port: s.port, password: s.password, ws })
      .then((c) => {
        conn = c
        return c
      })
      .catch((e: Error) => {
        retryAt = Date.now() + RETRY_MS
        throw e
      })
      .finally(() => {
        connecting = null
      })
    return connecting
  }

  return {
    id: 'obs',
    name: 'OBS Studio',
    async state(question, signal): Promise<BridgeState | null> {
      const request = question.request
      const map = typeof request === 'string' ? OBS_REQUESTS[request] : undefined
      if (!map || signal?.aborted) return null
      try {
        const c = await connection()
        return map(await c.request(request as string))
      } catch {
        return null
      }
    },
    async status(): Promise<BridgeStatus> {
      const base = { id: 'obs', name: 'OBS Studio' } as const
      try {
        const c = await connection(true)
        const v = await c.request('GetVersion')
        return {
          ...base,
          state: 'connected',
          ...(typeof v.obsVersion === 'string' ? { version: v.obsVersion } : {})
        }
      } catch (e) {
        const code = e instanceof ObsError && e.code !== 'request-failed' ? e.code : 'closed'
        return {
          ...base,
          state:
            code === 'password-needed'
              ? 'needs-setup'
              : code === 'auth-failed'
                ? 'error'
                : 'absent',
          detail: DETAIL[code]
        }
      }
    },
    reset(): void {
      conn?.close()
      conn = null
      retryAt = 0
    }
  }
}
