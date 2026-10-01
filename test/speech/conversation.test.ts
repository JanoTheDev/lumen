import { describe, expect, it } from 'vitest'
import {
  AssistantActivation,
  DOUBLE_TAP_GAP_MS,
  TAP_MS,
  type Timers
} from '../../src/main/speech/activation'
import { Conversation, IDLE_END_MS, REARM_MS } from '../../src/main/speech/conversation'

function fakeTimers(): { timers: Timers; advance: (ms: number) => void } {
  const pending: { fn: () => void; at: number; id: number }[] = []
  let now = 0
  let ids = 0
  return {
    timers: {
      set: (fn, ms) => {
        const id = ++ids
        pending.push({ fn, at: now + ms, id })
        return id
      },
      clear: (h) => {
        const i = pending.findIndex((p) => p.id === h)
        if (i >= 0) pending.splice(i, 1)
      }
    },
    advance: (ms) => {
      now += ms
      for (const p of [...pending].filter((p) => p.at <= now)) {
        pending.splice(pending.indexOf(p), 1)
        p.fn()
      }
    }
  }
}

interface Setup {
  c: Conversation
  calls: string[]
  advance: (ms: number) => void
  setRecording: (r: boolean) => boolean
}

function setup(opts: { recording?: boolean } = {}): Setup {
  const calls: string[] = []
  const t = fakeTimers()
  let recording = opts.recording ?? false
  const c = new Conversation(
    {
      listen: () => calls.push('listen'),
      recording: () => recording,
      cancel: () => calls.push('cancel'),
      status: (text) => calls.push(text ? 'status:on' : 'status:off')
    },
    t.timers
  )
  return { c, calls, advance: t.advance, setRecording: (r: boolean) => (recording = r) }
}

describe('Conversation', () => {
  it('listens again after a turn', () => {
    const { c, calls, advance } = setup()
    expect(c.toggle()).toBe(true)
    c.turnEnded()
    advance(REARM_MS - 1)
    expect(calls).toEqual(['status:on'])
    advance(1)
    expect(calls).toEqual(['status:on', 'listen'])
  })

  it('waits for the spoken reply to finish', () => {
    const { c, calls, advance } = setup()
    c.toggle()
    c.setSpeaking(true)
    c.turnEnded()
    advance(5000)
    expect(calls).not.toContain('listen')
    c.setSpeaking(false)
    advance(REARM_MS)
    expect(calls).toContain('listen')
  })

  it('a reply that starts after the turn ended is waited for too', () => {
    const { c, calls, advance } = setup()
    c.toggle()
    c.turnEnded()
    advance(100)
    c.setSpeaking(true)
    advance(5000)
    expect(calls).not.toContain('listen')
    c.setSpeaking(false)
    advance(REARM_MS)
    expect(calls.filter((x) => x === 'listen')).toHaveLength(1)
  })

  it('does not open a second recording', () => {
    const { c, calls, advance, setRecording } = setup()
    c.toggle()
    setRecording(true)
    c.turnEnded()
    advance(REARM_MS)
    expect(calls).not.toContain('listen')
  })

  it('a second double-tap leaves and cancels', () => {
    const { c, calls, advance } = setup()
    c.toggle()
    expect(c.toggle()).toBe(false)
    expect(calls).toEqual(['status:on', 'status:off', 'cancel'])
    c.turnEnded()
    advance(REARM_MS)
    expect(calls).not.toContain('listen')
  })

  it('ends after 5 minutes without a request; a request restarts the clock', () => {
    const { c, advance } = setup()
    c.toggle()
    advance(IDLE_END_MS - 1000)
    c.touch()
    advance(IDLE_END_MS - 1000)
    expect(c.active).toBe(true)
    advance(1000)
    expect(c.active).toBe(false)
  })

  it('turns end quietly when not in a conversation', () => {
    const { c, calls, advance } = setup()
    c.turnEnded()
    advance(REARM_MS)
    expect(calls).toEqual([])
  })
})

describe('AssistantActivation double-tap', () => {
  function act(mode: 'hold' | 'tap', enabled = true): { a: AssistantActivation; calls: string[] } {
    const calls: string[] = []
    let inConversation = false
    const t = fakeTimers()
    const a = new AssistantActivation(
      {
        start: (hf) => calls.push(hf ? 'start-hf' : 'start'),
        handsFree: () => calls.push('hands-free'),
        stop: () => calls.push('stop'),
        doubleTap: () => {
          inConversation = !inConversation
          calls.push(inConversation ? 'conv-on' : 'conv-off')
          return inConversation
        }
      },
      () => mode,
      t.timers,
      () => enabled
    )
    return { a, calls }
  }

  it('hold mode: tap, tap starts a conversation on the open recording', () => {
    const { a, calls } = act('hold')
    a.down(0)
    a.up(100)
    a.down(100 + DOUBLE_TAP_GAP_MS)
    a.up(150 + DOUBLE_TAP_GAP_MS)
    expect(calls).toEqual(['start', 'hands-free', 'conv-on'])
    expect(a.current).toBe('hands-free')
    // A single press later sends early, as in any hands-free recording.
    a.down(5000)
    a.up(5100)
    expect(calls.at(-1)).toBe('stop')
  })

  it('tap mode: the second quick tap is the double-tap, not a stop', () => {
    const { a, calls } = act('tap')
    a.down(0)
    a.up(80)
    a.down(200)
    a.up(260)
    expect(calls).toEqual(['start-hf', 'conv-on'])
  })

  it('a double-tap during a conversation leaves it', () => {
    const { a, calls } = act('hold')
    a.down(0)
    a.up(100)
    a.down(200)
    a.up(250)
    // Later: tap (stop) then tap again quickly.
    a.down(10_000)
    a.up(10_100)
    a.down(10_300)
    a.up(10_350)
    expect(calls).toEqual(['start', 'hands-free', 'conv-on', 'stop', 'conv-off'])
    expect(a.current).toBe('idle')
  })

  it('a slow second tap is an ordinary press', () => {
    const { a, calls } = act('hold')
    a.down(0)
    a.up(100)
    a.down(100 + DOUBLE_TAP_GAP_MS + 1)
    expect(calls).toEqual(['start', 'hands-free', 'stop'])
  })

  it('a long hold before does not count as a tap', () => {
    const { a, calls } = act('hold')
    a.down(0)
    a.up(TAP_MS + 300)
    a.down(TAP_MS + 400)
    expect(calls).toEqual(['start', 'stop', 'start'])
  })

  it('off in settings: the old behaviour', () => {
    const { a, calls } = act('hold', false)
    a.down(0)
    a.up(100)
    a.down(200)
    expect(calls).toEqual(['start', 'hands-free', 'stop'])
  })
})
