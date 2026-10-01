import { afterEach, describe, expect, it } from 'vitest'
import { Agent } from './agent'

let agent: Agent | undefined

afterEach(async () => {
  await agent?.close()
  agent = undefined
})

describe('protocol', () => {
  it('first line is the v2 ready event', async () => {
    agent = await Agent.start()
    expect(agent.raw[0]).toBeTruthy()
    const first = JSON.parse(agent.raw[0])
    expect(first.v).toBe(2)
    expect(first.event).toBe('ready')
    expect(['python', 'native']).toContain(agent.ready.impl)
    expect(agent.ready.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(Array.isArray(agent.ready.capabilities)).toBe(true)
  })

  it('ping answers with v2 framing', async () => {
    agent = await Agent.start()
    const f = await agent.request('ping')
    expect(f).toMatchObject({ v: 2, ok: true })
    expect(typeof f.result?.t).toBe('number')
  })

  it('unknown commands fail with E_UNSUPPORTED', async () => {
    agent = await Agent.start()
    const f = await agent.request('no_such_command')
    expect(f.ok).toBe(false)
    expect(f.error?.code).toBe('E_UNSUPPORTED')
    expect(f.error?.message).toContain('no_such_command')
  })

  it('garbage lines produce protocol-error and never stop the reader', async () => {
    agent = await Agent.start()
    agent.send('garbage')
    agent.send('[1,2,3]')
    agent.send('{"v":2,"id":')
    const ev = await agent.waitFor((f) => f.event === 'protocol-error')
    expect(ev).toEqual({ v: 2, event: 'protocol-error', data: { line: 'garbage' } })
    const f = await agent.request('ping')
    expect(f.ok).toBe(true)
  })

  it('echoes long garbage truncated to 200 characters', async () => {
    agent = await Agent.start()
    agent.send('x'.repeat(500))
    const ev = await agent.waitFor((f) => f.event === 'protocol-error')
    expect((ev.data?.line as string).length).toBe(200)
  })

  it('accepts flat v1-framed requests and answers in v2', async () => {
    agent = await Agent.start()
    agent.send({ id: 1, cmd: 'ping' })
    const f = await agent.waitFor((m) => m.id === 1)
    expect(f).toMatchObject({ v: 2, id: 1, ok: true })
  })

  it('preserves non-ascii text in frames', async () => {
    agent = await Agent.start()
    agent.send('héllo 世界 👋')
    const ev = await agent.waitFor((f) => f.event === 'protocol-error')
    expect(ev.data?.line).toBe('héllo 世界 👋')
  })

  it('cancel answers the target with E_CANCELLED', async () => {
    agent = await Agent.start()
    agent.send({ v: 2, id: 10, cmd: 'debug_sleep', args: { ms: 5000 } })
    const t0 = Date.now()
    const c = await agent.request('cancel', { target: 10 })
    expect(c.result).toEqual({ cancelled: true })
    const target = await agent.waitFor((f) => f.id === 10)
    expect(target.ok).toBe(false)
    expect(target.error?.code).toBe('E_CANCELLED')
    expect(Date.now() - t0).toBeLessThan(1000)
    const again = await agent.request('cancel', { target: 10 })
    expect(again.result).toEqual({ cancelled: false })
    const bad = await agent.request('cancel', { target: 'x' })
    expect(bad.error?.code).toBe('E_INVALID')
  })

  it('timeoutMs fails a slow call with E_TIMEOUT', async () => {
    agent = await Agent.start()
    const f = await agent.request('debug_sleep', { ms: 3000, timeoutMs: 150 })
    expect(f.error?.code).toBe('E_TIMEOUT')
  })

  it('inline commands answer while the read and input lanes are busy', async () => {
    agent = await Agent.start()
    agent.send({ v: 2, id: 20, cmd: 'debug_sleep', args: { ms: 2000 } })
    agent.send({ v: 2, id: 21, cmd: 'debug_sleep_input', args: { ms: 2000 } })
    const t0 = Date.now()
    await agent.ok('ping')
    expect(Date.now() - t0).toBeLessThan(500)
    await agent.request('cancel', { target: 20 })
    await agent.request('cancel', { target: 21 })
  })

  it('every stdout line is JSON under an event flood with concurrent requests', async () => {
    agent = await Agent.start()
    await agent.ok('debug_emit', { n: 3000 })
    const pings = Array.from({ length: 50 }, () => agent!.ok('ping'))
    await Promise.all(pings)
    await agent.waitFor((f) => f.event === 'debug' && f.data?.seq === 2999, 20_000)
    // Agent.onData JSON-parses every line, so reaching here means none were corrupted.
    expect(agent.frames.filter((f) => f.event === 'debug')).toHaveLength(3000)
  })

  it('init validates before applying', async () => {
    agent = await Agent.start()
    const ok = await agent.request('init', {
      hotkey: '',
      wake: { enabled: false, phrase: 'hey lumen', cancelPhrases: [] },
      dwell: { enabled: false, ms: 1400, cooldownMs: 1500 },
      logLevel: 'info'
    })
    expect(ok).toMatchObject({ ok: true, result: {} })
    const badLevel = await agent.request('init', { logLevel: 'loud' })
    expect(badLevel.error?.code).toBe('E_INVALID')
    const badHotkey = await agent.request('init', { hotkey: 'Ctrl+Nope', logLevel: 'info' })
    expect(badHotkey.error?.code).toBe('E_INVALID')
    const badSubs = await agent.request('init', { subscriptions: ['nope'], logLevel: 'info' })
    expect(badSubs.error?.code).toBe('E_UNSUPPORTED')
  })

  it('subscribe rejects unknown events', async () => {
    agent = await Agent.start()
    const f = await agent.request('subscribe', { events: ['not-an-event'], enabled: true })
    expect(f.error?.code).toBe('E_UNSUPPORTED')
    const bad = await agent.request('subscribe', { events: 'x' })
    expect(bad.error?.code).toBe('E_INVALID')
  })

  it('exits cleanly when stdin closes', async () => {
    agent = await Agent.start()
    await agent.ok('ping')
    expect(await agent.close()).toBe(0)
  })
})
