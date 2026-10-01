// NDJSON framing of the agent bridge (protocol v2): large lines, interleaving, noise on
// stdout/stderr. Lifecycle (restart, timeouts, init replay) is in agent-bridge*.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { AgentBridge } from '../src/main/agent/bridge'
import { FAKE_PATHS, fakeSpawn, flushMicrotasks, splitAt } from './helpers/fake-child'

async function started(): Promise<{
  bridge: AgentBridge
  child: ReturnType<ReturnType<typeof fakeSpawn>['latest']>
}> {
  const { spawnFn, latest } = fakeSpawn({ autoPing: true })
  const bridge = new AgentBridge({ spawnFn, paths: FAKE_PATHS })
  await bridge.start()
  return { bridge, child: latest() }
}

describe('AgentBridge framing', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('decodes a response split at every byte offset', async () => {
    const { bridge, child } = await started()
    const title = 'Größe — 日本 \u{1F600}'
    for (let cut = 1; ; cut++) {
      const pending = bridge.activeWindow()
      await flushMicrotasks()
      const id = child.last('active_window')!.id
      const line = JSON.stringify({ v: 2, id, ok: true, result: { title } }) + '\n'
      if (cut >= Buffer.byteLength(line)) {
        child.reply(id, { title })
        await pending
        break
      }
      child.emitRaw(splitAt(line, [cut, cut + 1, cut + 3]))
      await expect(pending).resolves.toBe(title)
    }
    bridge.stop()
  })

  it('reassembles a 400 KB line sent in 64 KB chunks in linear time', async () => {
    const { bridge, child } = await started()
    const seen: string[] = []
    bridge.onEvent('update', (d) => seen.push(String(d.text)))
    const text = 'x'.repeat(400 * 1024)
    const bytes = Buffer.from(JSON.stringify({ v: 2, event: 'update', data: { text } }) + '\n')
    const chunks: Buffer[] = []
    for (let i = 0; i < bytes.length; i += 64 * 1024) chunks.push(bytes.subarray(i, i + 64 * 1024))
    const t0 = performance.now()
    child.emitRaw(chunks)
    const ms = performance.now() - t0
    expect(seen).toEqual([text])
    expect(ms).toBeLessThan(50)
    bridge.stop()
  })

  it('a 4 MB line in 64 KB chunks stays fast', async () => {
    const { bridge, child } = await started()
    let got = 0
    bridge.onEvent('update', (d) => (got = String(d.text).length))
    const text = 'y'.repeat(4 * 1024 * 1024)
    const bytes = Buffer.from(JSON.stringify({ v: 2, event: 'update', data: { text } }) + '\n')
    const chunks: Buffer[] = []
    for (let i = 0; i < bytes.length; i += 64 * 1024) chunks.push(bytes.subarray(i, i + 64 * 1024))
    const t0 = performance.now()
    child.emitRaw(chunks)
    // A UIA snapshot of a busy window can be megabytes; pipe chunks are 64 KB.
    expect(performance.now() - t0).toBeLessThan(300)
    expect(got).toBe(text.length)
    bridge.stop()
  })

  it('a 4 MB line in 1 KB chunks stays linear', async () => {
    const { bridge, child } = await started()
    let got = 0
    bridge.onEvent('update', (d) => (got = String(d.text).length))
    const text = 'z'.repeat(4 * 1024 * 1024)
    const bytes = Buffer.from(JSON.stringify({ v: 2, event: 'update', data: { text } }) + '\n')
    const chunks: Buffer[] = []
    for (let i = 0; i < bytes.length; i += 1024) chunks.push(bytes.subarray(i, i + 1024))
    const t0 = performance.now()
    child.emitRaw(chunks)
    // 4096 small chunks: re-scanning or flattening the whole buffer per chunk took ~3 s.
    expect(performance.now() - t0).toBeLessThan(750)
    expect(got).toBe(text.length)
    bridge.stop()
  })

  it('keeps lines split across many chunks intact, with several lines per chunk', async () => {
    const { bridge, child } = await started()
    const seen: string[] = []
    bridge.onEvent('update', (d) => seen.push(String(d.text)))
    const texts = ['a', 'bb'.repeat(500), 'ccc', 'd'.repeat(3000)]
    const raw = texts
      .map((t) => JSON.stringify({ v: 2, event: 'update', data: { text: t } }) + '\n')
      .join('')
    child.emitRaw(raw.match(/[\s\S]{1,7}/g)!)
    expect(seen).toEqual(texts)
    bridge.stop()
  })

  it('routes interleaved events and responses in one chunk', async () => {
    const { bridge, child } = await started()
    const events: unknown[] = []
    bridge.onEvent('hotkey-down', (d) => events.push(d))
    const a = bridge.activeWindow()
    const b = bridge.request('ping', {})
    await flushMicrotasks(0)
    const idA = child.last('active_window')!.id
    const idB = child.last('ping')!.id
    const lines = [
      { v: 2, event: 'hotkey-down', data: { n: 1 } },
      { v: 2, id: idB, ok: true, result: { t: 7 } },
      { v: 2, event: 'hotkey-down', data: { n: 2 } },
      { v: 2, id: idA, ok: true, result: { title: 'Inbox' } },
      { v: 2, event: 'hotkey-down', data: { n: 3 } }
    ]
    child.emitRaw([lines.map((l) => JSON.stringify(l)).join('\n') + '\n'])
    await expect(a).resolves.toBe('Inbox')
    await expect(b).resolves.toBeDefined()
    expect(events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    bridge.stop()
  })

  it('ignores blank lines, CRLF endings and non-JSON stdout without dropping later frames', async () => {
    const { bridge, child } = await started()
    const events: unknown[] = []
    bridge.onEvent('hotkey-down', (d) => events.push(d))
    child.emitRaw([
      '\n\r\n',
      'thread panicked at src/x.rs\n',
      JSON.stringify({ v: 2, event: 'hotkey-down', data: { n: 1 } }) + '\r\n',
      '{"v":2,"event":"hotkey-down","data":\n',
      JSON.stringify({ v: 2, event: 'hotkey-down', data: { n: 2 } }) + '\n'
    ])
    expect(events).toEqual([{ n: 1 }, { n: 2 }])
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('non-JSON'))).toBe(true)
    expect(bridge.running).toBe(true)
    bridge.stop()
  })

  it('stderr text never reaches event handlers or pending calls', async () => {
    const { bridge, child } = await started()
    const handler = vi.fn()
    bridge.onEvent('hotkey-down', handler)
    const pending = bridge.activeWindow()
    await flushMicrotasks(0)
    const id = child.last('active_window')!.id
    child.emitStderr(`${JSON.stringify({ v: 2, event: 'hotkey-down', data: {} })}\n`)
    child.emitStderr(`${JSON.stringify({ v: 2, id, ok: true, result: { title: 'fake' } })}\n`)
    child.emitStderr('WARN capture slow\n')
    expect(handler).not.toHaveBeenCalled()
    child.reply(id, { title: 'real' })
    await expect(pending).resolves.toBe('real')
    bridge.stop()
  })

  it('a response for an unknown id is dropped', async () => {
    const { bridge, child } = await started()
    child.emitLine({ v: 2, id: 99999, ok: true, result: {} })
    const pending = bridge.activeWindow()
    await flushMicrotasks(0)
    child.reply(child.last('active_window')!.id, { title: 'ok' })
    await expect(pending).resolves.toBe('ok')
    bridge.stop()
  })

  it('restarting resets a half-received line from the old process', async () => {
    const { spawnFn, latest } = fakeSpawn()
    const bridge = new AgentBridge({ spawnFn, paths: FAKE_PATHS })
    await bridge.start()
    latest().emitRaw(['{"v":2,"event":"hotkey-down","da'])
    bridge.stop()
    await bridge.start()
    const events: unknown[] = []
    bridge.onEvent('hotkey-down', (d) => events.push(d))
    latest().emitLine({ v: 2, event: 'hotkey-down', data: { n: 1 } })
    expect(events).toEqual([{ n: 1 }])
    bridge.stop()
  })
})
