import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ nativeImage: {} }))

import type { ElementNode } from '@shared/types'
import {
  checksFor,
  verify,
  verifyExpectation,
  verifyStats,
  type Check,
  type Observation,
  type Verdict,
  type VerifyDeps
} from '../../src/main/ai/verify'
import { diffRatio, setFrameCodec, type GrayImage } from '../../src/main/ai/frames'
import type { FrameGeometry } from '../../src/main/actions/coords'

// Fake frames: the "base64" is a key into this table of 100x50 gray images.
const W = 100
const H = 50
const images = new Map<string, GrayImage>()
function frame(key: string, paint?: (x: number, y: number) => number): string {
  const data = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = paint?.(x, y) ?? 128
  images.set(key, { w: W, h: H, data })
  return key
}
const crops: string[] = []

const geometry: FrameGeometry = {
  originX: 0,
  originY: 0,
  width: 1000,
  height: 500,
  imgW: W,
  imgH: H
}

function obs(over: Partial<Observation> = {}): Observation {
  return { at: 0, title: 'Inbox - Gmail', image: 'plain', geometry, ...over }
}

function node(over: Partial<ElementNode>): ElementNode {
  return {
    id: 'e1',
    role: 'button',
    name: 'Compose',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    monitorId: 1,
    enabled: true,
    patterns: [],
    ...over
  }
}
const uia = (...children: ElementNode[]): Observation['uia'] => ({
  snapshotId: 's',
  root: node({ id: 'root', role: 'window', name: 'Gmail', children })
})

let visionCalls = 0
const vision: VerifyDeps = {
  vision: async () => {
    visionCalls++
    return { ok: false, confidence: 0.7, reason: 'wrong page', evidence: 'vision' }
  }
}

describe('verify (T20)', () => {
  beforeEach(() => {
    visionCalls = 0
    crops.length = 0
    frame('plain')
    frame('changed', (x) => (x < 50 ? 0 : 255))
    // A 10x10 px change in the top-left corner only: 2% of the frame, 100% locally.
    frame('corner', (x, y) => (x < 10 && y < 10 ? 255 : 128))
    frame('caret', (x, y) => (x === 70 && y === 30 ? 200 : 128))
    setFrameCodec({
      gray: (b64) => images.get(b64) ?? null,
      crop: (b64) => {
        crops.push(b64)
        return `crop:${b64}`
      }
    })
  })
  afterEach(() => setFrameCodec(null))

  it('diffs perceptually: a caret blink is not a change', () => {
    expect(diffRatio(images.get('plain')!, images.get('caret')!)).toBeLessThan(0.005)
    expect(diffRatio(images.get('plain')!, images.get('changed')!)).toBeGreaterThan(0.4)
  })

  it('title change settles a navigation without the model', async () => {
    const v = await verify(
      {
        description: 'open weather',
        checks: checksFor([{ type: 'open_url', url: 'https://weather.com' }])
      },
      obs({ title: 'New Tab' }),
      obs({ title: 'Weather - Chrome', image: 'plain' }),
      undefined,
      vision
    )
    expect(v).toMatchObject({ ok: true, evidence: 'title' })
    expect(visionCalls).toBe(0)
  })

  it('typed text found in the focused field passes via UIA', async () => {
    const after = obs({
      focus: { role: 'edit', name: 'Subject', editable: true, valueTail: 'Re: Resignation' }
    })
    const v = await verify(
      { description: 'type subject', checks: checksFor([{ type: 'type', text: 'Resignation' }]) },
      obs(),
      after,
      undefined,
      vision
    )
    expect(v).toMatchObject({ ok: true, evidence: 'uia' })
  })

  it('a field holding other text fails via UIA', async () => {
    const after = obs({
      image: 'changed',
      focus: { role: 'edit', name: 'To', editable: true, valueTail: 'someone@x.com' }
    })
    const v = await verify(
      { description: 'type subject', checks: checksFor([{ type: 'type', text: 'Resignation' }]) },
      obs(),
      after,
      undefined,
      vision
    )
    expect(v).toMatchObject({ ok: false, evidence: 'uia' })
    expect(visionCalls).toBe(0)
  })

  it('an unchanged screen fails via diff', async () => {
    const v = await verify(
      { description: 'click Compose', checks: checksFor([{ type: 'click', x: 1, y: 1 }]) },
      obs(),
      obs({ image: 'caret' }),
      undefined,
      vision
    )
    expect(v).toMatchObject({ ok: false, evidence: 'diff' })
  })

  it('a change around the target passes via diff', async () => {
    const v = await verify(
      {
        description: 'click Compose',
        checks: checksFor([{ type: 'click', x: 1, y: 1 }], [{ x: 0, y: 0, w: 60, h: 60 }])
      },
      obs(),
      obs({ image: 'corner' }),
      undefined,
      vision
    )
    expect(v).toMatchObject({ ok: true, evidence: 'diff' })
  })

  it('UIA element checks: exists, gone, focused, value', async () => {
    const after = obs({
      uia: uia(
        node({ id: 'e2', name: 'Send' }),
        node({ id: 'e3', role: 'edit', name: 'Subject', focused: true, value: 'Hello' })
      )
    })
    const run = (check: Check): Promise<Verdict> =>
      verify({ description: 'x', checks: [check] }, obs(), after, undefined, {
        vision: null
      })
    expect(await run({ kind: 'element', state: 'exists', name: 'send' })).toMatchObject({
      ok: true,
      evidence: 'uia'
    })
    expect(await run({ kind: 'element', state: 'gone', name: 'Discard' })).toMatchObject({
      ok: true
    })
    expect(await run({ kind: 'element', state: 'focused', name: 'Subject' })).toMatchObject({
      ok: true
    })
    expect(
      await run({ kind: 'element', state: 'value', name: 'Subject', value: 'hello' })
    ).toMatchObject({
      ok: true,
      confidence: 0.95
    })
    expect(
      await run({ kind: 'element', state: 'value', name: 'Subject', value: 'Bye' })
    ).toMatchObject({
      ok: false
    })
  })

  it('falls back to vision with before/after crops only when inconclusive', async () => {
    // 'corner' changes 2% globally... use a smaller change: inconclusive band (0.5%-2%).
    frame('small', (x, y) => (x < 8 && y < 8 ? 255 : 128))
    const v = await verify(
      {
        description: 'click Compose',
        successCriteria: 'compose window open',
        checks: [{ kind: 'screen-changed', region: { x: 500, y: 250, w: 50, h: 20 } }],
        region: { x: 500, y: 250, w: 50, h: 20 }
      },
      obs(),
      obs({ image: 'small' }),
      undefined,
      vision
    )
    expect(visionCalls).toBe(1)
    expect(crops).toEqual(['plain', 'small'])
    expect(v).toMatchObject({ ok: false, evidence: 'vision' })
    expect(verifyStats().vision).toBeGreaterThan(0)
  })

  it('inconclusive without a model assumes success with low confidence', async () => {
    frame('small', (x, y) => (x < 8 && y < 8 ? 255 : 128))
    const v = await verify(
      { description: 'x', checks: [{ kind: 'screen-changed' }] },
      obs(),
      obs({ image: 'small' }),
      undefined,
      { vision: null }
    )
    expect(v.ok).toBe(true)
    expect(v.confidence).toBeLessThan(0.5)
  })

  it('a cancelled verification throws instead of guessing', async () => {
    frame('small', (x, y) => (x < 8 && y < 8 ? 255 : 128))
    const ac = new AbortController()
    const deps: VerifyDeps = {
      vision: async (_i, signal) => {
        ac.abort()
        signal?.throwIfAborted()
        return null
      }
    }
    await expect(
      verify({ description: 'x', checks: [] }, obs(), obs({ image: 'small' }), ac.signal, deps)
    ).rejects.toThrow()
  })

  describe('verifyExpectation (07 API)', () => {
    it('window-title', async () => {
      const v = await verifyExpectation(
        { check: 'window-title', title: 'Preferences' },
        obs({ title: 'Blender' }),
        obs({ title: 'Blender Preferences' })
      )
      expect(v).toMatchObject({ ok: true, evidence: 'title' })
    })

    it('uia-event focused', async () => {
      const v = await verifyExpectation(
        { check: 'uia-event', event: 'focused', element: { name: 'Subject' } },
        obs(),
        obs({ uia: uia(node({ name: 'Subject', focused: true })) })
      )
      expect(v).toMatchObject({ ok: true, evidence: 'uia' })
    })

    it('vision asks the model and does not assume success', async () => {
      const v = await verifyExpectation(
        { check: 'vision', prompt: 'Has the viewport angle changed?' },
        obs(),
        obs({ image: 'changed' }),
        undefined,
        { vision: null }
      )
      expect(v).toMatchObject({ ok: false, confidence: 0 })
      const yes = await verifyExpectation(
        { check: 'vision', prompt: 'Has the viewport angle changed?' },
        obs(),
        obs({ image: 'changed' }),
        undefined,
        {
          vision: async () => ({ ok: true, confidence: 0.7, reason: 'rotated', evidence: 'vision' })
        }
      )
      expect(yes).toMatchObject({ ok: true, evidence: 'vision' })
    })

    it('manual checks are left to the caller', async () => {
      const v = await verifyExpectation({ check: 'manual' }, obs(), obs())
      expect(v).toMatchObject({ ok: false, confidence: 0 })
    })
  })
})
