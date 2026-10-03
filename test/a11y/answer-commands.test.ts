import { describe, expect, it } from 'vitest'
import { A11yCommands, LOCAL_HANDLED } from '../../src/main/a11y/dispatch'
import { IDLE_CONTEXT, parseCommand } from '../../src/main/a11y/voice-commands'
import { fakeA11yIo, type FakeA11yOptions } from '../helpers/fake-a11y-io'

const recent = { ...IDLE_CONTEXT, recentAnswer: true }

describe('answer and notice commands: grammar', () => {
  it('repeat / say that again replay a recent answer', () => {
    for (const u of [
      'repeat that',
      'say that again',
      'what did you say',
      'read it again',
      'repeat',
      'Repeat the answer, please'
    ])
      expect(parseCommand(u, recent)?.id, u).toBe('answer.repeat')
    expect(parseCommand('repeat that', IDLE_CONTEXT)).toBeNull()
  })

  it('reading and guides keep their own "repeat"', () => {
    expect(parseCommand('say that again', { ...recent, reading: true })?.id).toBe('read.skip')
  })

  it('"copy the answer" copies; plain "copy" stays Ctrl+C', () => {
    expect(parseCommand('copy the answer', recent)?.id).toBe('answer.copy')
    expect(parseCommand('copy that', recent)?.id).toBe('answer.copy')
    expect(parseCommand('copy your answer', recent)?.id).toBe('answer.copy')
    expect(parseCommand('copy', recent)).toMatchObject({
      id: 'key.fixed',
      args: { combo: 'ctrl+c' }
    })
    expect(parseCommand('copy that', IDLE_CONTEXT)).toMatchObject({
      id: 'key.fixed',
      args: { combo: 'ctrl+c' }
    })
  })

  it('"undo" and "unmute" press the notice button only while it is offered', () => {
    expect(parseCommand('undo that', { ...IDLE_CONTEXT, notice: 'undo' })?.id).toBe('notice.undo')
    expect(parseCommand('undo', { ...IDLE_CONTEXT, notice: 'undo' })?.id).toBe('notice.undo')
    expect(parseCommand('undo', IDLE_CONTEXT)).toMatchObject({ args: { combo: 'ctrl+z' } })
    expect(parseCommand('unmute', { ...IDLE_CONTEXT, notice: 'unmute' })?.id).toBe('notice.unmute')
    expect(parseCommand('undo', { ...IDLE_CONTEXT, notice: 'unmute' })?.id).toBe('key.fixed')
    expect(parseCommand('unmute', IDLE_CONTEXT)?.id).not.toBe('notice.unmute')
  })
})

function setup(
  opts: FakeA11yOptions & { recent?: boolean; notice?: 'undo' | 'unmute' | null } = {}
): {
  a11y: A11yCommands
  ops: string[]
  pressed: string[]
  said: string[]
  feedback: { text: string; ok: boolean }[]
  say: (u: string) => Promise<unknown>
} {
  const f = fakeA11yIo(opts)
  const ops: string[] = []
  const pressed: string[] = []
  f.io.recentAnswer = () => opts.recent ?? false
  f.io.answer = (op) => {
    ops.push(op)
    return opts.recent ?? false
  }
  f.io.notice = () => opts.notice ?? null
  f.io.pressNotice = (a) => {
    pressed.push(a)
    return opts.notice === a
  }
  const a11y = new A11yCommands(f.io)
  return {
    a11y,
    ops,
    pressed,
    said: f.calls.said,
    feedback: f.calls.feedback,
    say: async (u) => {
      const r = a11y.tryHandle(u)
      await f.settle()
      return r
    }
  }
}

describe('answer and notice commands: dispatch', () => {
  it('"repeat that" replays the recent answer', async () => {
    const s = setup({ recent: true })
    expect(await s.say('repeat that')).toEqual({ response: LOCAL_HANDLED })
    expect(s.ops).toEqual(['repeat'])
  })

  it('"copy the answer" copies and says so', async () => {
    const s = setup({ recent: true })
    await s.say('copy the answer')
    expect(s.ops).toEqual(['copy'])
    expect(s.feedback).toContainEqual({ text: 'Copied.', ok: true })
  })

  it('no recent answer: "repeat that" goes on to the router', async () => {
    const s = setup({ recent: false })
    expect(await s.say('repeat that')).toBeNull()
  })

  it('"undo that" / "unmute" press the notice button', async () => {
    const u = setup({ notice: 'undo' })
    await u.say('undo that')
    expect(u.pressed).toEqual(['undo'])
    const m = setup({ notice: 'unmute' })
    await m.say('unmute')
    expect(m.pressed).toEqual(['unmute'])
  })

  it('"what can I say about buddies" says that group\'s rows', async () => {
    const s = setup()
    expect(await s.say('what can I say about buddies')).toEqual({ response: LOCAL_HANDLED })
    expect(s.said).toHaveLength(1)
    expect(s.said[0]).toMatch(/^For buddies, you can say:/)
    expect(s.said[0]).toContain('pause all buddies')
  })

  it('an unknown help topic goes on to the router', async () => {
    const s = setup()
    expect(await s.say('help me with my taxes')).toBeNull()
  })
})
