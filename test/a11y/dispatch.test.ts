import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
const providerCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../src/main/ai/providers', () => ({
  getProvider: () => {
    providerCalls.n++
    throw new Error('no model calls in this test')
  }
}))

import { A11yCommands, LOCAL_HANDLED, spellOut } from '../../src/main/a11y/dispatch'
import { routeLocal, setLocalGrammar } from '../../src/main/query/router'
import { fakeA11yIo, node, type FakeA11y, type FakeA11yOptions } from '../helpers/fake-a11y-io'

let live: A11yCommands[] = []

interface Setup extends FakeA11y {
  a11y: A11yCommands
  /** Says one utterance and lets the command finish. */
  say: (u: string) => Promise<{ response: unknown } | null>
}

function setup(opts: FakeA11yOptions = {}): Setup {
  const f = fakeA11yIo(opts)
  const a11y = new A11yCommands(f.io)
  live.push(a11y)
  const say = async (u: string): Promise<{ response: unknown } | null> => {
    const r = a11y.tryHandle(u)
    await f.settle()
    return r
  }
  return { ...f, a11y, say }
}

afterEach(() => {
  for (const a of live) a.stopAutoScroll()
  live = []
  setLocalGrammar(null)
})

/** Ten buttons in two rows, physical px. */
function buttons(): ReturnType<typeof node>[] {
  return Array.from({ length: 10 }, (_, i) =>
    node(`Button ${i + 1}`, {
      x: 30 + (i % 5) * 200,
      y: 30 + Math.floor(i / 5) * 100,
      w: 120,
      h: 40
    })
  )
}

describe('routing (T04)', () => {
  it('"scroll down" reaches agent input at once, with no model call', () => {
    const { io, calls, a11y } = setup()
    live.push(a11y)
    setLocalGrammar((u) => a11y.tryHandle(u))
    const handle = vi.fn()
    const t0 = performance.now()
    const res = routeLocal(
      'scroll down',
      { guideActive: false, hasLastGuide: false, hasLastTask: false },
      handle
    )
    const ms = performance.now() - t0
    expect(res).toEqual(LOCAL_HANDLED)
    expect(calls.input).toEqual([[{ t: 'scroll', dx: 0, dy: 5 }]])
    expect(ms).toBeLessThan(150)
    expect(handle).not.toHaveBeenCalled()
    expect(providerCalls.n).toBe(0)
    expect(io).toBeDefined()
  })

  it('"what\'s the weather" during a guide falls through to the router', async () => {
    const { say } = setup({ guide: true })
    expect(await say("what's the weather")).toBeNull()
  })

  it('"back" is guide navigation during a guide, browser back otherwise', async () => {
    expect(await setup({ guide: true }).say('back')).toBeNull()
    const s = setup()
    expect(await s.say('go back')).toEqual({ response: LOCAL_HANDLED })
    expect(s.calls.input).toEqual([[{ t: 'keys', combo: 'alt+left' }]])
  })

  it('leaves free requests and cancel words to the router', async () => {
    const { say, calls } = setup()
    for (const u of ['how do I make a table', 'cancel', 'stop', 'cancel my subscription', '5'])
      expect(await say(u)).toBeNull()
    expect(calls.input).toEqual([])
  })

  it('"what can I say" answers with the command sheet', async () => {
    const { say } = setup()
    const r = (await say('what can I say')) as { response: { mode: string; text: string } }
    expect(r.response.mode).toBe('answer')
    expect(r.response.text).toMatch(/scroll/i)
  })
})

describe('basic commands (T05)', () => {
  it.each([
    ['scroll up', [{ t: 'scroll', dx: 0, dy: -5 }]],
    ['scroll down a lot', [{ t: 'scroll', dx: 0, dy: 15 }]],
    ['scroll left a little', [{ t: 'scroll', dx: -3, dy: 0 }]],
    ['scroll down 2 times', [{ t: 'scroll', dx: 0, dy: 10 }]],
    ['scroll to the top', [{ t: 'keys', combo: 'ctrl+home' }]],
    ['press enter', [{ t: 'keys', combo: 'enter' }]],
    ['press control s', [{ t: 'keys', combo: 'ctrl+s' }]],
    [
      'press tab 3 times',
      [
        { t: 'keys', combo: 'tab' },
        { t: 'keys', combo: 'tab' },
        { t: 'keys', combo: 'tab' }
      ]
    ],
    ['copy', [{ t: 'keys', combo: 'ctrl+c' }]],
    ['paste', [{ t: 'keys', combo: 'ctrl+v' }]],
    ['select all', [{ t: 'keys', combo: 'ctrl+a' }]],
    ['undo', [{ t: 'keys', combo: 'ctrl+z' }]],
    ['redo', [{ t: 'keys', combo: 'ctrl+y' }]],
    ['go forward', [{ t: 'keys', combo: 'alt+right' }]],
    ['new tab', [{ t: 'keys', combo: 'ctrl+t' }]],
    ['close tab', [{ t: 'keys', combo: 'ctrl+w' }]],
    ['next tab', [{ t: 'keys', combo: 'ctrl+tab' }]],
    ['previous tab', [{ t: 'keys', combo: 'ctrl+shift+tab' }]],
    ['tab 3', [{ t: 'keys', combo: 'ctrl+3' }]],
    ['minimize', [{ t: 'keys', combo: 'win+down' }]],
    ['maximize', [{ t: 'keys', combo: 'win+up' }]],
    ['show desktop', [{ t: 'keys', combo: 'win+d' }]],
    ['switch window', [{ t: 'keys', combo: 'alt+tab' }]],
    ['type hello world', [{ t: 'type', text: 'hello world' }]],
    ['click', [{ t: 'click', button: 'left', count: 1 }]],
    ['double click', [{ t: 'click', button: 'left', count: 2 }]],
    ['right click', [{ t: 'click', button: 'right', count: 1 }]]
  ])('"%s" → agent input', async (utterance, steps) => {
    const { say, calls } = setup()
    expect(await say(utterance)).toEqual({ response: LOCAL_HANDLED })
    expect(calls.input).toEqual([steps])
  })

  it('keeps the case of typed text', async () => {
    const { say, calls } = setup()
    await say('Type Hello, World')
    expect(calls.input).toEqual([[{ t: 'type', text: 'Hello, World' }]])
  })

  it('nudges the mouse in logical px, sent as physical', async () => {
    const { say, calls } = setup({ scale: 1.5, cursor: { x: 100, y: 100 } })
    await say('move mouse right')
    expect(calls.input).toEqual([[{ t: 'move', x: 225, y: 150 }]])
  })

  it('blocks denylisted shortcuts with a reason and sends nothing', async () => {
    const { say, calls } = setup()
    await say('press windows r')
    expect(calls.input).toEqual([])
    expect(calls.feedback.at(-1)).toEqual({ text: expect.stringMatching(/blocked/), ok: false })
  })

  it('does not type into a terminal', async () => {
    const { say, calls } = setup({ title: 'Windows PowerShell' })
    await say('type dir')
    expect(calls.input).toEqual([])
    expect(calls.feedback.at(-1)?.ok).toBe(false)
  })

  it('opens apps through Start search, known sites by URL, never shells', async () => {
    const s = setup()
    await s.say('open notepad')
    expect(s.calls.input).toEqual([
      [
        { t: 'keys', combo: 'ctrl+esc' },
        { t: 'wait', ms: 450 },
        { t: 'type', text: 'notepad' },
        { t: 'wait', ms: 450 },
        { t: 'keys', combo: 'enter' }
      ]
    ])
    await s.say('open gmail')
    expect(s.calls.urls).toEqual(['https://mail.google.com'])
    s.calls.input.length = 0
    await s.say('open powershell')
    expect(s.calls.input).toEqual([])
    expect(s.calls.feedback.at(-1)?.ok).toBe(false)
  })

  it('auto-scroll starts and "stop" stops it', async () => {
    vi.useFakeTimers()
    try {
      const { a11y, calls } = setup()
      a11y.tryHandle('start scrolling down')
      await vi.advanceTimersByTimeAsync(600)
      expect(calls.input.length).toBe(2)
      expect(a11y.tryHandle('stop')).toEqual({ response: LOCAL_HANDLED })
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls.input.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports dwell that is not set up, and toggles the wake word', async () => {
    const s = setup({ dwell: false })
    await s.say('pause dwell')
    expect(s.calls.feedback.at(-1)?.ok).toBe(false)
    await s.say('go to sleep')
    expect(s.calls.wake).toEqual([false])
    await s.say('open settings')
    expect(s.calls.settings).toBe(1)
  })

  it('"click <name>" acts only on an exact control name', async () => {
    const compose = node('Compose', { x: 10, y: 10, w: 80, h: 30 })
    const s = setup({ nodes: [compose] })
    expect(await s.say('click compose')).toEqual({ response: LOCAL_HANDLED })
    expect(s.calls.uia).toEqual([{ elementId: compose.id, action: 'invoke' }])
    expect(await s.say('click the big blue thing')).toBeNull()
  })

  it('spells letters and NATO words', () => {
    expect(spellOut('c a t')).toBe('cat')
    expect(spellOut('capital alpha bravo dot c o m')).toBe('Ab.com')
    expect(spellOut('alpha banana')).toBeNull()
  })
})

describe('numbers (T06)', () => {
  it('"show numbers" draws marks in logical px', async () => {
    const s = setup({ nodes: buttons(), scale: 1.5 })
    await s.say('show numbers')
    expect(s.calls.snapshots).toEqual(['foreground'])
    expect(s.scene.marks).toHaveLength(10)
    expect(s.scene.marks![0]).toEqual({ n: 1, rect: { x: 20, y: 20, w: 80, h: 80 / 3 } })
    expect(s.calls.feedback.at(-1)).toEqual({ text: '10 numbers', ok: true })
  })

  it('"click 5" with numbers shown invokes it, then hides the numbers', async () => {
    const nodes = buttons()
    const s = setup({ nodes })
    await s.say('show numbers')
    expect(await s.say('click 5')).toEqual({ response: LOCAL_HANDLED })
    expect(s.calls.uia).toEqual([{ elementId: nodes[4].id, action: 'invoke' }])
    expect(s.calls.input).toEqual([])
    expect(s.scene.marks).toBeUndefined()
    expect(s.a11y.marks.shown).toBe(false)
  })

  it('a bare number clicks while numbers are shown and keeps them when asked', async () => {
    const s = setup({ nodes: buttons(), keep: true })
    await s.say('show numbers')
    await s.say('3')
    expect(s.calls.uia).toHaveLength(1)
    expect(s.scene.marks).toHaveLength(10)
  })

  it('clicks at the centre when the control cannot be invoked', async () => {
    const s = setup({ nodes: buttons(), uiaOk: false })
    await s.say('show numbers')
    await s.say('click 1')
    expect(s.calls.input).toEqual([[{ t: 'click', button: 'left', count: 1, x: 90, y: 50 }]])
  })

  it('right and double click go to the centre in physical px', async () => {
    const s = setup({ nodes: buttons(), keep: true })
    await s.say('show numbers')
    await s.say('right click 2')
    await s.say('double click 6')
    expect(s.calls.input).toEqual([
      [{ t: 'click', button: 'right', count: 1, x: 290, y: 50 }],
      [{ t: 'click', button: 'left', count: 2, x: 90, y: 150 }]
    ])
  })

  it('"click 5" with no numbers up shows them first and clicks nothing', async () => {
    const s = setup({ nodes: buttons() })
    await s.say('click 5')
    expect(s.scene.marks).toHaveLength(10)
    expect(s.calls.uia).toEqual([])
    expect(s.calls.input).toEqual([])
    expect(s.calls.feedback.at(-1)?.text).toMatch(/say 5/i)
  })

  it('an unknown number says why', async () => {
    const s = setup({ nodes: buttons() })
    await s.say('show numbers')
    await s.say('click 42')
    expect(s.calls.feedback.at(-1)).toEqual({ text: 'No number 42 on screen', ok: false })
  })

  it('"numbers for links" filters by role, "hide numbers" clears', async () => {
    const nodes = [
      ...buttons(),
      node('Docs', { x: 30, y: 400, w: 60, h: 20 }, 'hyperlink'),
      node('Blog', { x: 130, y: 400, w: 60, h: 20 }, 'hyperlink')
    ]
    const s = setup({ nodes })
    await s.say('numbers for links')
    expect(s.scene.marks).toHaveLength(2)
    await s.say('hide numbers')
    expect(s.scene.marks).toBeUndefined()
  })

  it('reuses a fresh set-of-marks table without a new snapshot', async () => {
    const nodes = buttons()
    const table = nodes.map((n, i) => ({
      n: i + 1,
      physRect: n.rect,
      source: 'uia' as const,
      label: n.name,
      elementId: n.id
    }))
    const s = setup({ nodes, recent: { table, at: 900 } })
    await s.say('show numbers')
    expect(s.calls.snapshots).toEqual([])
    expect(s.scene.marks).toHaveLength(10)
  })

  it('"keep numbers" saves the setting', async () => {
    const s = setup()
    await s.say('keep numbers')
    expect(s.calls.keep).toEqual([true])
  })

  it('reset takes numbers away', async () => {
    const s = setup({ nodes: buttons() })
    await s.say('show numbers')
    s.a11y.reset()
    expect(s.scene.marks).toBeUndefined()
    expect(await s.say('5')).toBeNull()
  })
})

describe('mouse grid (T07)', () => {
  const monitors = [
    { id: 1, bounds: { x: 0, y: 0, w: 1920, h: 1080 } },
    { id: 2, bounds: { x: 1920, y: 0, w: 1280, h: 720 } }
  ]

  it('shows on the monitor under the cursor, or the one asked for', async () => {
    const s = setup({ monitors, cursor: { x: 2000, y: 10 } })
    await s.say('mouse grid')
    expect(s.scene.grid).toEqual({ rect: monitors[1].bounds, cols: 3, rows: 3, level: 0 })
    await s.say('cancel')
    expect(s.scene.grid).toBeUndefined()
    await s.say('mouse grid 1')
    expect(s.scene.grid?.rect).toEqual(monitors[0].bounds)
    await s.say('mouse grid 3')
    expect(s.calls.feedback.at(-1)).toEqual({ text: 'There is no monitor 3', ok: false })
  })

  it('zooms with numbers, goes back with undo, clicks the centre and closes', async () => {
    const s = setup({ scale: 2 })
    await s.say('mouse grid')
    await s.say('9')
    expect(s.scene.grid).toEqual({
      rect: { x: 1280, y: 720, w: 640, h: 360 },
      cols: 3,
      rows: 3,
      level: 1
    })
    await s.say('1')
    await s.say('undo')
    expect(s.scene.grid?.level).toBe(1)
    expect(s.calls.input).toEqual([])
    await s.say('click')
    expect(s.calls.input).toEqual([[{ t: 'click', button: 'left', count: 1, x: 3200, y: 1800 }]])
    expect(s.scene.grid).toBeUndefined()
    expect(s.a11y.grid.shown).toBe(false)
  })

  it('drag, select, drop drags between the two cell centres', async () => {
    const s = setup()
    await s.say('mouse grid')
    await s.say('1')
    await s.say('drag')
    expect(s.scene.grid?.level).toBe(0)
    await s.say('9')
    await s.say('drop')
    expect(s.calls.input).toEqual([
      [{ t: 'drag', from: { x: 320, y: 180 }, to: { x: 1600, y: 900 } }]
    ])
    expect(s.scene.grid).toBeUndefined()
  })

  it('"drop" before "drag" is not a command', async () => {
    const s = setup()
    await s.say('mouse grid')
    expect(await s.say('drop')).toBeNull()
  })

  it('"show numbers" replaces the grid', async () => {
    const s = setup({ nodes: buttons() })
    await s.say('mouse grid')
    await s.say('show numbers')
    expect(s.scene.grid).toBeUndefined()
    expect(s.scene.marks).toHaveLength(10)
  })
})
