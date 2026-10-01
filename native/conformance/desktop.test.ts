// UIA, input and OCR against the WinForms fixture. Needs an interactive desktop.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Agent } from './agent'
import { Fixture, sleep, startFixture } from './fixture'

interface Node {
  id: string
  role: string
  name: string
  automationId?: string
  value?: string
  rect: { x: number; y: number; w: number; h: number }
  monitorId: number
  enabled: boolean
  patterns: string[]
  children?: Node[]
}

let agent: Agent
let fixture: Fixture

beforeAll(async () => {
  agent = await Agent.start()
  fixture = await startFixture()
  await sleep(500)
})

afterAll(async () => {
  fixture?.close()
  await agent?.close()
})

function flatten(n: Node, out: Node[] = []): Node[] {
  out.push(n)
  n.children?.forEach((c) => flatten(c, out))
  return out
}

async function snapshot(): Promise<{ snapshotId: string; nodes: Node[] }> {
  const r = await agent.ok<{ snapshotId: string; root: Node }>('uia_snapshot', {
    scope: fixture.hwnd,
    maxNodes: 100
  })
  return { snapshotId: r.snapshotId, nodes: flatten(r.root) }
}

async function find(query: Record<string, unknown>): Promise<Node[]> {
  const r = await agent.ok<{ elements: Node[] }>('uia_find', { query })
  return r.elements
}

describe('focus_window', () => {
  it('brings the fixture to the front by hwnd and by process', async (ctx) => {
    const probe = await agent.request('focus_window', { hwnd: fixture.hwnd })
    if (probe.error?.code === 'E_UNSUPPORTED') ctx.skip()
    expect(probe.ok).toBe(true)
    const w = await agent.ok('active_window')
    expect(w.hwnd).toBe(fixture.hwnd)
    expect(w.title).toBe('LumenFixture')
    expect(w.process).toBe('powershell.exe')
    expect(w.isBrowser).toBe(false)
    expect((await agent.request('focus_window', { hwnd: 1 })).error?.code).toBe('E_NOT_FOUND')
    const none = await agent.request('focus_window', { process: 'no-such-app' })
    expect(none.error?.code).toBe('E_NOT_FOUND')
    expect((await agent.request('focus_window', {})).error?.code).toBe('E_INVALID')
  })
})

describe('uia', () => {
  it('snapshot has the C3 node shape and the fixture controls', async (ctx) => {
    if (!agent.has('uia')) ctx.skip()
    const { snapshotId, nodes } = await snapshot()
    expect(typeof snapshotId).toBe('string')
    const btn = nodes.find((n) => n.role === 'button' && n.name === 'Increment')
    expect(btn).toBeTruthy()
    expect(btn!.id).toMatch(/^e\d+$/)
    expect(btn!.automationId).toBe('incrementButton')
    expect(btn!.patterns).toContain('invoke')
    expect(btn!.enabled).toBe(true)
    expect(btn!.rect.w).toBeGreaterThan(0)
    expect(Number.isInteger(btn!.monitorId)).toBe(true)
    expect(nodes.find((n) => n.role === 'checkbox' && n.name === 'Remember')?.patterns).toContain(
      'toggle'
    )
    expect(nodes.some((n) => n.role === 'edit' && n.automationId === 'nameBox')).toBe(true)
    const secret = nodes.find((n) => n.automationId === 'secretBox')
    expect(secret?.value ?? '').not.toContain('hunter2')
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length)
  })

  it('invoke increments the counter without moving the pointer', async (ctx) => {
    if (!agent.has('uia')) ctx.skip()
    const { nodes } = await snapshot()
    const btn = nodes.find((n) => n.name === 'Increment')!
    const r = await agent.ok('uia_act', { elementId: btn.id, action: 'invoke' })
    expect(r.done).toBe(true)
    expect(r.fallbackUsed ?? false).toBe(false)
    await sleep(200)
    await snapshot()
    expect((await find({ name: 'Count: 1' })).length).toBe(1)
  })

  it('toggle, find and errors', async (ctx) => {
    if (!agent.has('uia')) ctx.skip()
    const { nodes } = await snapshot()
    const chk = nodes.find((n) => n.name === 'Remember')!
    expect((await agent.ok('uia_act', { elementId: chk.id, action: 'toggle' })).done).toBe(true)
    const byRole = await find({ role: 'checkbox' })
    expect(byRole.map((n) => n.name)).toContain('Remember')
    const sub = await find({ name: 'increm' })
    expect(sub[0]?.name).toBe('Increment')
    expect(await find({ name: 'No such control' })).toEqual([])
    const gone = await agent.request('uia_act', { elementId: 'e99999', action: 'invoke' })
    expect(gone.error?.code).toBe('E_NOT_FOUND')
    const bad = await agent.request('uia_act', { elementId: chk.id, action: 'explode' })
    expect(bad.error?.code).toBe('E_INVALID')
  })

  it('set_value writes into a text box', async (ctx) => {
    if (!agent.has('uia')) ctx.skip()
    const { nodes } = await snapshot()
    const box = nodes.find((n) => n.automationId === 'nameBox')!
    const r = await agent.request('uia_act', {
      elementId: box.id,
      action: 'set_value',
      value: 'set by uia',
      allowTerminal: true
    })
    expect(r.ok).toBe(true)
    await snapshot()
    expect((await find({ automationId: 'nameBox' }))[0].value).toBe('set by uia')
  })

  it('uia-event reports invoke and value changes in the foreground window', async (ctx) => {
    if (!(agent.has('uia-events') && agent.has('uia'))) ctx.skip()
    await agent.ok('focus_window', { hwnd: fixture.hwnd })
    await agent.ok('subscribe', { events: ['uia-event'], enabled: true })
    try {
      await sleep(600) // the watcher registers on the foreground window (250 ms poll)
      const from = agent.frames.length
      const { nodes } = await snapshot()
      const btn = nodes.find((n) => n.name === 'Increment')!
      await agent.ok('uia_act', { elementId: btn.id, action: 'invoke' })
      const inv = await agent.waitFor(
        (f) => f.event === 'uia-event' && f.data?.kind === 'invoked',
        5000,
        from
      )
      expect(inv.data?.element).toMatchObject({ name: 'Increment', role: 'button' })
      const box = nodes.find((n) => n.automationId === 'nameBox')!
      await agent.ok('uia_act', {
        elementId: box.id,
        action: 'set_value',
        value: 'watched',
        allowTerminal: true
      })
      const val = await agent.waitFor(
        (f) => f.event === 'uia-event' && f.data?.kind === 'value',
        5000,
        from
      )
      expect(val.data?.element).toMatchObject({ automationId: 'nameBox', value: 'watched' })
    } finally {
      await agent.ok('subscribe', { events: ['uia-event'], enabled: false })
    }
  })
})

describe('input', () => {
  it('types unicode into the focused text box', async (ctx) => {
    if (!(agent.has('input') && agent.has('uia'))) ctx.skip()
    const { nodes } = await snapshot()
    const box = nodes.find((n) => n.automationId === 'nameBox')!
    await agent.ok('uia_act', {
      elementId: box.id,
      action: 'set_value',
      value: '',
      allowTerminal: true
    })
    await agent.ok('uia_act', { elementId: box.id, action: 'focus' })
    const text = 'héllo 世界 👋'
    await agent.ok('input', { steps: [{ t: 'type', text }], allowTerminal: true })
    await sleep(200)
    await snapshot()
    expect((await find({ automationId: 'nameBox' }))[0].value).toBe(text)
  })

  it('clicks a button by physical coordinates', async (ctx) => {
    if (!(agent.has('input') && agent.has('uia'))) ctx.skip()
    const { nodes } = await snapshot()
    const before = nodes.find(
      (n) => n.automationId === 'countLabel' || n.name.startsWith('Count:')
    )!.name
    const btn = nodes.find((n) => n.name === 'Increment')!
    const x = btn.rect.x + Math.floor(btn.rect.w / 2)
    const y = btn.rect.y + Math.floor(btn.rect.h / 2)
    await agent.ok('input', { steps: [{ t: 'click', x, y }] })
    await sleep(200)
    const after = (await snapshot()).nodes.find((n) => n.name.startsWith('Count:'))!.name
    expect(Number(after.split(':')[1])).toBe(Number(before.split(':')[1]) + 1)
  })

  it('denies dangerous combos and validates steps', async (ctx) => {
    if (!agent.has('input')) ctx.skip()
    const win = await agent.request('input', { steps: [{ t: 'keys', combo: 'Win+R' }] })
    expect(win.error?.code).toBe('E_DENIED')
    const cad = await agent.request('input', { steps: [{ t: 'keys', combo: 'Ctrl+Alt+Delete' }] })
    expect(cad.error?.code).toBe('E_DENIED')
    const bad = await agent.request('input', { steps: [{ t: 'teleport' }] })
    expect(bad.error?.code).toBe('E_INVALID')
    const waited = await agent.ok('input', { steps: [{ t: 'wait', ms: 50 }] })
    expect(waited.done).toBe(true)
  })
})

describe('ocr', () => {
  it('reads the fixture label from a captured frame', async (ctx) => {
    if (!(agent.has('ocr') && agent.has('capture'))) ctx.skip()
    const { nodes } = await snapshot().catch(() => ({ nodes: [] as Node[] }))
    const win = await agent.ok<{ hwnd: number; rect: Node['rect'] }>('active_window')
    const root = nodes[0]?.rect ?? win.rect
    const cap = await agent.ok<{ frames: { id: string }[] }>('capture', {
      region: root,
      maxWidth: 0
    })
    const r = await agent.ok<{
      words: { text: string; rect: Node['rect'] }[]
      lines: { text: string }[]
    }>('ocr', {
      frameId: cap.frames[0].id
    })
    expect(r.lines.some((l) => /count:/i.test(l.text))).toBe(true)
    const w = r.words.find((x) => /^count/i.test(x.text))!
    expect(w.rect.x).toBeGreaterThanOrEqual(root.x)
    expect(w.rect.y).toBeGreaterThanOrEqual(root.y)
    const expired = await agent.request('ocr', { frameId: 'f-nope' })
    expect(expired.error?.code).toBe('E_NOT_FOUND')
  })
})
