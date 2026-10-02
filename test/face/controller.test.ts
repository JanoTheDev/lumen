import { describe, expect, it, vi } from 'vitest'
import type { FaceFrame } from '@shared/channels'
import { FACE_DEFAULTS, type FaceConfig } from '@shared/config'
import { FaceController, detectorOptions } from '../../src/main/face/controller'
import {
  inputSteps,
  isRepeatable,
  runFaceAction,
  type FaceActionDeps
} from '../../src/main/face/actions'

const frame = (p: Partial<FaceFrame> = {}): FaceFrame => ({
  face: true,
  mouthOpen: 0,
  browRaise: 0,
  smile: 0,
  roll: 0,
  yaw: 0,
  pitch: 0,
  ...p
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(cfg: Partial<FaceConfig> = {}) {
  let now = 0
  let wake: (() => void) | null = null
  const config: FaceConfig = { ...FACE_DEFAULTS, ...cfg }
  const run = vi.fn()
  const saveThreshold = vi.fn()
  const saveRange = vi.fn()
  const c = new FaceController({
    now: () => now,
    sleep: () => new Promise<void>((r) => (wake = r)),
    config: () => config,
    run,
    saveThreshold,
    saveRange
  })
  const tick = (f: FaceFrame, ms: number): void => {
    for (let t = 0; t < ms; t += 66) {
      now += 66
      c.onFrame(f)
    }
  }
  const finishSample = async (): Promise<void> => {
    wake?.()
    await Promise.resolve()
  }
  return { c, run, saveThreshold, saveRange, tick, finishSample, config }
}

describe('face controller', () => {
  it('runs the bound action of a held gesture', () => {
    const { c, run, tick } = setup()
    c.setStatus('running')
    tick(frame({ mouthOpen: 0.8 }), 600)
    expect(run).toHaveBeenCalledWith('click', 'mouthOpen')
    expect(c.state(true).last?.gesture).toBe('mouthOpen')
  })

  it('reports levels relative to the threshold', () => {
    const { c, tick } = setup()
    c.setStatus('running')
    tick(frame({ mouthOpen: 0.45 }), 66)
    const s = c.state(true)
    expect(s.levels.mouthOpen).toBeCloseTo(1)
    expect(s.frame?.face).toBe(true)
    c.setStatus('off')
    expect(c.state(true).frame).toBeNull()
  })

  it('calibrates rest then a gesture without acting meanwhile', async () => {
    const { c, run, saveThreshold, tick, finishSample } = setup()
    c.setStatus('running')
    expect((await c.calibrateGesture('smile')).ok).toBe(false)

    const rest = c.calibrateRest()
    expect(c.state(true).calibrating).toBe(true)
    tick(frame({ smile: 0.05 }), 1500)
    await finishSample()
    expect((await rest).ok).toBe(true)

    const g = c.calibrateGesture('smile')
    tick(frame({ smile: 0.8, mouthOpen: 0.9 }), 1500)
    await finishSample()
    const r = await g
    expect(r.ok).toBe(true)
    expect(saveThreshold).toHaveBeenCalledWith('smile', expect.objectContaining({ dir: 1 }))
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses calibration while the camera is off', async () => {
    const { c } = setup()
    const r = await c.calibrateRest()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Turn on face gestures/)
  })

  it('leaves head turns to the head pointer while it is on', () => {
    const bindings = { ...FACE_DEFAULTS.bindings, turnLeft: 'click' as const }
    expect(detectorOptions({ ...FACE_DEFAULTS, bindings }).active).toContain('turnLeft')
    const o = detectorOptions({
      ...FACE_DEFAULTS,
      bindings,
      pointer: { ...FACE_DEFAULTS.pointer, enabled: true }
    })
    expect(o.active).not.toContain('turnLeft')
    expect(o.active).toContain('mouthOpen')
  })

  it('calibrates the head pointer range from five looks', async () => {
    const { c, run, saveRange, tick, finishSample } = setup()
    c.setStatus('running')
    const look = async (
      at: 'centre' | 'left' | 'right' | 'up' | 'down',
      yaw: number,
      pitch: number
    ): Promise<{ ok: boolean; message: string }> => {
      const p = c.calibrateRange(at)
      tick(frame({ yaw, pitch }), 1500)
      await finishSample()
      return p
    }
    expect((await look('centre', 2, -5)).ok).toBe(true)
    expect((await look('left', -18, -5)).message).toBe('Left is set.')
    expect((await look('right', 22, -5)).ok).toBe(true)
    expect((await look('up', 2, -20)).ok).toBe(true)
    // Bottom barely moved: refused, the others are kept.
    const bad = await look('down', 2, -3)
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/bottom/)
    const r = await look('down', 2, 9)
    expect(r).toMatchObject({ ok: true, message: 'Pointer range is set.' })
    expect(saveRange).toHaveBeenCalledWith({
      yaw: { centre: 2, neg: -18, pos: 22 },
      pitch: { centre: -5, neg: -20, pos: 9 }
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('repeats scroll gestures only', () => {
    const o = detectorOptions({
      ...FACE_DEFAULTS,
      bindings: { ...FACE_DEFAULTS.bindings, browRaise: 'scroll-up', mouthOpen: 'click' }
    })
    expect(o.repeatMs).toEqual({ browRaise: 500 })
    expect(isRepeatable('click')).toBe(false)
  })
})

describe('face actions', () => {
  const deps = (): FaceActionDeps => ({
    input: vi.fn(async () => true),
    switchPress: vi.fn(() => false),
    toggleDwellPause: vi.fn(() => true),
    voice: vi.fn(),
    pointerPause: vi.fn(() => false),
    pointerRecentre: vi.fn(() => true)
  })

  it('maps clicks and scrolls to input at the pointer', async () => {
    expect(inputSteps('double-click')).toEqual([{ t: 'click', button: 'left', count: 2 }])
    expect(inputSteps('scroll-up')).toEqual([{ t: 'scroll', dx: 0, dy: -3 }])
    expect(inputSteps('voice')).toBeNull()
    const d = deps()
    expect(await runFaceAction('right-click', d)).toEqual({ ok: true })
    expect(d.input).toHaveBeenCalledWith([{ t: 'click', button: 'right' }])
  })

  it('presses the switch, toggles dwell and starts voice', async () => {
    const d = deps()
    expect(await runFaceAction('switch-next', d)).toEqual({
      ok: false,
      why: 'Switch scanning is off.'
    })
    expect(d.switchPress).toHaveBeenCalledWith('next')
    expect((await runFaceAction('dwell-pause', d)).ok).toBe(true)
    await runFaceAction('voice', d)
    expect(d.voice).toHaveBeenCalled()
    expect((await runFaceAction('none', d)).ok).toBe(false)
  })

  it('pauses and recentres the head pointer', async () => {
    const d = deps()
    expect(await runFaceAction('pointer-pause', d)).toEqual({
      ok: false,
      why: 'The head pointer is off.'
    })
    expect(await runFaceAction('pointer-recentre', d)).toEqual({ ok: true })
    expect(d.pointerRecentre).toHaveBeenCalled()
  })
})
