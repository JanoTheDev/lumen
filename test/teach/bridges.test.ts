import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { inflateRawSync } from 'zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { realClock } from '../../src/main/a11y/timings'
import { newBudget, startCheck } from '../../src/main/teach/checks'
import type { CheckSpec } from '../../src/main/teach/lesson'
import { noopPorts, type CheckResult } from '../../src/main/teach/ports'
import { BlenderClient, blenderBridge, ensureToken } from '../../src/main/teach/bridges/blender'
import {
  changedBase,
  hasList,
  matchExpect,
  type BridgeState
} from '../../src/main/teach/bridges/expect'
import { makeBridgePort } from '../../src/main/teach/bridges/port'
import { connectObs, obsAuth, type WsLike } from '../../src/main/teach/bridges/obs-client'
import { OBS_REQUESTS, obsBridge } from '../../src/main/teach/bridges/obs'
import { BridgeSecrets } from '../../src/main/teach/bridges/secrets'
import type { AppBridge } from '../../src/main/teach/bridges/types'
import { folderEntries, zip } from '../../src/main/packs/zip-write'

const ROOT = join(__dirname, '..', '..')
const bridgeKeys = JSON.parse(
  readFileSync(join(ROOT, 'skills', 'schema', 'bridge-keys.json'), 'utf8')
) as Record<string, { keys?: string[]; requests?: Record<string, string[]> }>

/** What the add-on's `state` returns (bridges/blender/lumen_bridge/__init__.py). */
const BLENDER_STATE: BridgeState = {
  mode: 'OBJECT',
  active_object: 'Cube',
  active_object_type: 'MESH',
  selected: ['Cube'],
  active_editor_under_mouse: null,
  workspace: 'Layout',
  scene_frame: 1,
  render_engine: 'BLENDER_EEVEE_NEXT',
  last_operator: { idname: 'OBJECT_OT_select_all', name: 'Select All' },
  op_seq: 3,
  operators: [{ seq: 3, idname: 'OBJECT_OT_select_all', name: 'Select All' }],
  object_count: 3,
  file_path: '',
  is_dirty: false,
  mesh_select_mode: 'VERTEX',
  selected_face_count: null,
  properties_context: 'OBJECT',
  viewport_shading: 'SOLID',
  active_material_base_color: [0.8, 0.8, 0.8, 1]
}

const resolvable = (state: BridgeState, key: string): boolean => {
  if (key === 'last_operator' || key in state) return true
  const c = changedBase(key)
  if (c && c in state) return true
  const l = hasList(key)
  return !!l && Array.isArray(state[l])
}

describe('bridge-keys.json vocabulary', () => {
  it('every Blender key means something in the add-on state', () => {
    for (const k of bridgeKeys.blender.keys!) expect(resolvable(BLENDER_STATE, k), k).toBe(true)
  })

  it('every OBS key means something in its request’s state', () => {
    const sample: Record<string, Record<string, unknown>> = {
      GetRecordStatus: { outputActive: false, outputPaused: false },
      GetRecordDirectory: { recordDirectory: 'C:/Videos' },
      GetCurrentProgramScene: { sceneName: 'Scene' },
      GetSceneList: { currentProgramSceneName: 'Scene', scenes: [{ sceneName: 'Scene' }] },
      GetInputList: { inputs: [{ inputName: 'Mic', inputKind: 'wasapi_input_capture' }] }
    }
    for (const [req, keys] of Object.entries(bridgeKeys.obs.requests!)) {
      expect(OBS_REQUESTS[req], req).toBeDefined()
      const state = OBS_REQUESTS[req](sample[req])
      for (const k of keys) expect(resolvable(state, k), `${req}.${k}`).toBe(true)
    }
  })
})

describe('matchExpect', () => {
  it('compares values, ignoring case for strings', () => {
    expect(matchExpect(BLENDER_STATE, { mode: 'object', workspace: 'Layout' }, null)).toBe(true)
    expect(matchExpect(BLENDER_STATE, { mode: 'EDIT_MESH' }, null)).toBe(false)
    expect(matchExpect({ n: 2 }, { n: { gte: 1 } }, null)).toBe(true)
    expect(matchExpect({ n: 0 }, { n: { gte: 1 } }, null)).toBe(false)
    expect(matchExpect({ n: 'x' }, { n: { gte: 1 } }, null)).toBe(false)
    expect(matchExpect({ a: 1 }, { missing: 1 }, null)).toBe(false)
  })

  it('"changed" keys compare with the baseline', () => {
    const base = { recordDirectory: 'C:/a' }
    expect(matchExpect({ recordDirectory: 'C:/a' }, { recordDirectoryChanged: true }, base)).toBe(
      false
    )
    expect(matchExpect({ recordDirectory: 'C:/b' }, { recordDirectoryChanged: true }, base)).toBe(
      true
    )
    expect(matchExpect({ recordDirectory: 'C:/b' }, { recordDirectoryChanged: true }, null)).toBe(
      false
    )
    const color = { active_material_base_color: [0.8, 0.8, 0.8, 1] }
    expect(
      matchExpect(
        { active_material_base_color: [1, 0, 0, 1] },
        { active_material_base_color_changed: true },
        color
      )
    ).toBe(true)
  })

  it('has<Key> looks in the plural list; request is a selector', () => {
    const s = { request: 'x', inputKinds: ['monitor_capture'] }
    expect(matchExpect(s, { request: 'GetInputList', hasInputKind: 'monitor_capture' }, null)).toBe(
      true
    )
    expect(matchExpect(s, { hasInputKind: 'wasapi_input_capture' }, null)).toBe(false)
  })

  it('last_operator needs that operator to run after the baseline', () => {
    const base = { ...BLENDER_STATE, op_seq: 3 }
    const later = {
      ...BLENDER_STATE,
      op_seq: 5,
      operators: [
        { seq: 3, idname: 'TRANSFORM_OT_translate' },
        { seq: 4, idname: 'TRANSFORM_OT_rotate' },
        { seq: 5, idname: 'OBJECT_OT_select_all' }
      ]
    }
    expect(matchExpect(later, { last_operator: 'TRANSFORM_OT_rotate' }, base)).toBe(true)
    expect(matchExpect(later, { last_operator: 'TRANSFORM_OT_translate' }, base)).toBe(false)
    expect(matchExpect(later, { last_operator: 'TRANSFORM_OT_rotate' }, null)).toBe(false)
  })
})

describe('makeBridgePort', () => {
  const fake = (states: (BridgeState | null)[]): Map<string, AppBridge> => {
    const b: AppBridge = {
      id: 'obs',
      name: 'OBS',
      state: async () => states.shift() ?? null,
      status: async () => ({ id: 'obs', name: 'OBS', state: 'connected' })
    }
    return new Map([['obs', b]])
  }

  it('keeps the first answer per check as the baseline', async () => {
    const map = fake([{ sceneName: 'A' }, { sceneName: 'A' }, { sceneName: 'B' }])
    const port = makeBridgePort(() => map)
    const ac = new AbortController()
    const q = { request: 'GetCurrentProgramScene', sceneNameChanged: true }
    expect(await port.query('obs', q, ac.signal)).toBe('fail')
    expect(await port.query('obs', q, ac.signal)).toBe('fail')
    expect(await port.query('obs', q, ac.signal)).toBe('pass')
  })

  it('answers unknown with no bridge or no connection', async () => {
    const port = makeBridgePort(() => fake([null]))
    expect(await port.query('obs', { request: 'GetRecordStatus' })).toBe('unknown')
    expect(await port.query('davinci-resolve', { page: 'edit' })).toBe('unknown')
  })
})

describe('anyOf with a bridge', () => {
  const spec: CheckSpec = {
    type: 'anyOf',
    checks: [
      { type: 'bridge', app: 'blender', expect: { mode: 'EDIT_MESH' } },
      { type: 'vision', prompt: 'Is edit mode on?' }
    ]
  }
  const run = async (answer: CheckResult): Promise<number> => {
    vi.useFakeTimers()
    const capture = vi.fn(async () => ({ id: 'f' }))
    const ports = noopPorts({
      bridge: { query: async () => answer },
      screen: { capture, diff: () => 0, emitScene: () => {}, emitState: () => {} }
    })
    const h = startCheck(spec, {
      ports,
      clock: realClock,
      step: { id: 's', say: 'x', target: null, check: spec, hints: [] },
      budget: newBudget(),
      log: () => {}
    })
    await vi.advanceTimersByTimeAsync(2000)
    h.cancel()
    vi.useRealTimers()
    return capture.mock.calls.length
  }

  it('skips vision while the bridge answers', async () => {
    expect(await run('fail')).toBe(0)
  })

  it('falls back to vision when the bridge is absent', async () => {
    expect(await run('unknown')).toBeGreaterThan(0)
  })
})

describe('Blender client', () => {
  let server: Server | null = null
  const dirs: string[] = []
  afterEach(() => {
    server?.close()
    server = null
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const listen = (reply: (req: Record<string, unknown>) => unknown): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((sock) => {
        let buf = ''
        sock.setEncoding('utf8')
        sock.on('data', (d: string) => {
          buf += d
          const nl = buf.indexOf('\n')
          if (nl < 0) return
          const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
          sock.write(JSON.stringify({ id: req.id, ...(reply(req) as object) }) + '\n')
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  it('sends the token and returns the state', async () => {
    const seen: Record<string, unknown>[] = []
    const port = await listen((req) => {
      seen.push(req)
      return req.token === 'tok' ? { ok: true, result: { mode: 'OBJECT' } } : { ok: false }
    })
    const b = blenderBridge(new BlenderClient(() => 'tok', { port }))
    expect(await b.state({})).toEqual({ mode: 'OBJECT' })
    expect(seen[0]).toMatchObject({ cmd: 'state', token: 'tok' })
  })

  it('reports a wrong token and a closed Blender', async () => {
    const port = await listen(() => ({ ok: false, error: 'unauthorized' }))
    const b = blenderBridge(new BlenderClient(() => 'bad', { port }))
    expect((await b.status()).state).toBe('error')
    server!.close()
    server = null
    const st = await blenderBridge(new BlenderClient(() => 'x', { port })).status()
    expect(st.state).toBe('absent')
  })

  it('ensureToken makes a 64-hex token once and keeps it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumen-token-'))
    dirs.push(dir)
    const file = join(dir, 'sub', 'blender-bridge.token')
    const t = ensureToken(file)
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(ensureToken(file)).toBe(t)
    writeFileSync(file, 'short')
    expect(ensureToken(file)).not.toBe('short')
  })
})

/** A scripted obs-websocket server on the WsLike interface. */
function fakeObs(opts: { password?: string; responses?: Record<string, unknown> }): {
  factory: (url: string, protocol: string) => WsLike
  sent: Record<string, unknown>[]
} {
  const sent: Record<string, unknown>[] = []
  const factory = (): WsLike => {
    const handlers: Record<string, ((ev: { data?: unknown; code?: number }) => void)[]> = {}
    const emit = (t: string, ev: { data?: unknown; code?: number } = {}): void =>
      (handlers[t] ?? []).forEach((h) => h(ev))
    const ws: WsLike = {
      readyState: 1,
      addEventListener: (t, cb) => {
        ;(handlers[t] ??= []).push(cb)
      },
      close: (code) => queueMicrotask(() => emit('close', { code: code ?? 1000 })),
      send: (data) => {
        const msg = JSON.parse(data) as { op: number; d: Record<string, unknown> }
        sent.push(msg)
        if (msg.op === 1) {
          const want = opts.password ? obsAuth(opts.password, 'salt', 'chal') : undefined
          if (want && msg.d.authentication !== want)
            return queueMicrotask(() => emit('close', { code: 4009 }))
          queueMicrotask(() =>
            emit('message', { data: JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }) })
          )
        } else if (msg.op === 6) {
          const type = msg.d.requestType as string
          const data = opts.responses?.[type]
          queueMicrotask(() =>
            emit('message', {
              data: JSON.stringify({
                op: 7,
                d: {
                  requestType: type,
                  requestId: msg.d.requestId,
                  requestStatus: { result: !!data, code: data ? 100 : 204 },
                  responseData: data
                }
              })
            })
          )
        }
      }
    }
    queueMicrotask(() => {
      emit('open')
      const auth = opts.password ? { authentication: { challenge: 'chal', salt: 'salt' } } : {}
      emit('message', { data: JSON.stringify({ op: 0, d: { rpcVersion: 1, ...auth } }) })
    })
    return ws
  }
  return { factory, sent }
}

describe('obs-websocket client', () => {
  it('authenticates and runs requests', async () => {
    const obs = fakeObs({ password: 'pw', responses: { GetRecordStatus: { outputActive: true } } })
    const c = await connectObs({ password: 'pw', ws: obs.factory })
    expect(await c.request('GetRecordStatus')).toEqual({ outputActive: true })
    expect(obs.sent[0]).toMatchObject({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0 } })
    await expect(c.request('GetNope')).rejects.toMatchObject({ code: 'request-failed' })
    c.close()
  })

  it('tells a missing and a wrong password apart', async () => {
    await expect(connectObs({ ws: fakeObs({ password: 'pw' }).factory })).rejects.toMatchObject({
      code: 'password-needed'
    })
    await expect(
      connectObs({ password: 'nope', ws: fakeObs({ password: 'pw' }).factory })
    ).rejects.toMatchObject({ code: 'auth-failed' })
  })

  it('obsAuth follows the v5 recipe', () => {
    const h = (s: string): string => createHash('sha256').update(s).digest('base64')
    expect(obsAuth('pw', 'salt', 'chal')).toBe(h(h('pwsalt') + 'chal'))
    expect(obsAuth('pw', 'salt', 'chal')).not.toBe(obsAuth('pw', 'salt', 'other'))
  })
})

describe('OBS bridge', () => {
  it('maps GetInputList to input kinds and answers status', async () => {
    const obs = fakeObs({
      responses: {
        GetInputList: {
          inputs: [
            {
              inputName: 'Display',
              inputKind: 'monitor_capture',
              unversionedInputKind: 'monitor_capture'
            }
          ]
        },
        GetVersion: { obsVersion: '32.0.1' }
      }
    })
    const b = obsBridge(() => ({ port: 4455 }), obs.factory)
    const state = await b.state({ request: 'GetInputList' })
    expect(
      matchExpect(state!, { request: 'GetInputList', hasInputKind: 'monitor_capture' }, null)
    ).toBe(true)
    expect(await b.state({ request: 'StartRecord' })).toBeNull()
    expect(await b.status()).toMatchObject({ state: 'connected', version: '32.0.1' })
    b.reset()
  })

  it('asks for setup when OBS wants a password', async () => {
    const b = obsBridge(() => ({ port: 4455 }), fakeObs({ password: 'pw' }).factory)
    expect(await b.status()).toMatchObject({ state: 'needs-setup' })
  })
})

describe('BridgeSecrets', () => {
  it('stores the OBS password encrypted and clears it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumen-bs-'))
    try {
      const cipher = {
        available: () => true,
        encrypt: (t: string) => Buffer.from([...Buffer.from(t)].map((b) => b ^ 0x5a)),
        decrypt: (b: Buffer) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString()
      }
      const file = join(dir, 'bridges.dat')
      const s = new BridgeSecrets(file, cipher)
      expect(s.obs()).toEqual({ port: 4455 })
      expect(s.setObs({ port: 4460, password: 'secret' })).toBe(true)
      expect(readFileSync(file).toString()).not.toContain('secret')
      expect(new BridgeSecrets(file, cipher).obs()).toEqual({ port: 4460, password: 'secret' })
      s.clearObs()
      expect(new BridgeSecrets(file, cipher).obs()).toEqual({ port: 4455 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('add-on zip', () => {
  it('packs the add-on folder under lumen_bridge/', () => {
    const src = join(ROOT, 'bridges', 'blender', 'lumen_bridge')
    const entries = folderEntries(src, 'lumen_bridge')
    const names = entries.map((e) => e.name)
    expect(names).toContain('lumen_bridge/__init__.py')
    expect(names).toContain('lumen_bridge/blender_manifest.toml')
    expect(names.some((n) => n.includes('__pycache__'))).toBe(false)

    // Read it back: end record → central directory → local headers → inflate.
    const buf = zip(entries)
    const end = buf.length - 22
    expect(buf.readUInt32LE(end)).toBe(0x06054b50)
    const count = buf.readUInt16LE(end + 10)
    let p = buf.readUInt32LE(end + 16)
    const out: Record<string, string> = {}
    for (let i = 0; i < count; i++) {
      expect(buf.readUInt32LE(p)).toBe(0x02014b50)
      const size = buf.readUInt32LE(p + 20)
      const nameLen = buf.readUInt16LE(p + 28)
      const local = buf.readUInt32LE(p + 42)
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString()
      const dataAt = local + 30 + buf.readUInt16LE(local + 26)
      out[name] = inflateRawSync(buf.subarray(dataAt, dataAt + size)).toString()
      p += 46 + nameLen
    }
    expect(out['lumen_bridge/__init__.py']).toBe(readFileSync(join(src, '__init__.py'), 'utf8'))
    expect(Object.keys(out).sort()).toEqual(names.sort())
    expect(readdirSync(src)).toContain('server.py')
  })
})
