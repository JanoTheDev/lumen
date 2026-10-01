import { describe, expect, it } from 'vitest'
import { InputLane, USER_PAUSE_MS, type LaneClock } from '../../src/main/agent-mode/input-lane'

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Fake executor: records the start and end of each batch, each step yields. */
function executor(log: string[]) {
  return (who: string, steps = 3) =>
    async (): Promise<string> => {
      for (let i = 0; i < steps; i++) {
        log.push(`${who}:${i}`)
        await tick()
      }
      return who
    }
}

function fakeClock(): LaneClock & { t: number } {
  const c = {
    t: 0,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms
      await tick()
    }
  }
  return c
}

const interleaved = (log: string[], steps = 3): boolean => {
  for (let i = 0; i < log.length; i += steps) {
    const who = log[i].split(':')[0]
    for (let j = 1; j < steps; j++) if (log[i + j]?.split(':')[0] !== who) return true
  }
  return false
}

describe('InputLane', () => {
  it('two concurrent requesters never interleave input', async () => {
    const lane = new InputLane(fakeClock())
    const log: string[] = []
    const run = executor(log)
    await Promise.all([
      lane.run('a', run('a')),
      lane.run('b', run('b')),
      lane.run('a', run('a')),
      lane.run('lesson', run('lesson'))
    ])
    expect(log).toHaveLength(12)
    expect(interleaved(log)).toBe(false)
  })

  it('user input never interleaves with the holder batch either', async () => {
    const lane = new InputLane(fakeClock())
    const log: string[] = []
    const run = executor(log)
    const release = await lane.acquire('agent')
    await Promise.all([
      lane.run('agent', run('agent')),
      lane.run('dwell', run('dwell'), { user: true }),
      lane.run('switch', run('switch'), { user: true })
    ])
    release()
    expect(interleaved(log)).toBe(false)
    expect(log.filter((l) => l.startsWith('dwell'))).toHaveLength(3)
  })

  it('the lane has one holder; others wait FIFO', async () => {
    const lane = new InputLane(fakeClock())
    const r1 = await lane.acquire('one')
    const order: string[] = []
    const p2 = lane.acquire('two').then((r) => (order.push('two'), r))
    const p3 = lane.acquire('three').then((r) => (order.push('three'), r))
    expect(lane.holderName()).toBe('one')
    expect(lane.queued()).toEqual(['two', 'three'])
    r1()
    r1() // idempotent
    const r2 = await p2
    expect(lane.holderName()).toBe('two')
    r2()
    ;(await p3)()
    expect(order).toEqual(['two', 'three'])
    expect(lane.holderName()).toBeNull()
  })

  it('a non-holder batch waits for the holder to release', async () => {
    const lane = new InputLane(fakeClock())
    const log: string[] = []
    const release = await lane.acquire('agent')
    const lesson = lane.run('lesson', executor(log)('lesson', 1))
    await tick(5)
    expect(log).toEqual([])
    release()
    await lesson
    expect(log).toEqual(['lesson:0'])
  })

  it('user input does not wait for the holder and pauses its next batch', async () => {
    const clock = fakeClock()
    const lane = new InputLane(clock)
    const release = await lane.acquire('agent')
    await lane.run('dwell', async () => 'x', { user: true })
    expect(lane.paused()).toBe(true)
    const t0 = clock.t
    await lane.run('agent', async () => 'y')
    expect(clock.t - t0).toBeGreaterThanOrEqual(USER_PAUSE_MS)
    release()
  })

  it('an aborted waiter leaves the queue', async () => {
    const lane = new InputLane(fakeClock())
    const release = await lane.acquire('one')
    const ac = new AbortController()
    const p = lane.acquire('two', ac.signal)
    ac.abort()
    await expect(p).rejects.toBeTruthy()
    expect(lane.queued()).toEqual([])
    release()
    expect(lane.holderName()).toBeNull()
  })

  it('a failing batch does not block the next one', async () => {
    const lane = new InputLane(fakeClock())
    await expect(
      lane.run('a', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(lane.run('b', async () => 'ok')).resolves.toBe('ok')
    expect(lane.holderName()).toBeNull()
  })
})
