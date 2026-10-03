// Face settings: a polled face:state only replaces the drawn state when something shown changed.
import { describe, expect, it } from 'vitest'
import type { FaceState } from '@shared/channels'
import { sameFaceState } from '../src/renderer/src/panel/settings/sections/face-state'

const base = (): FaceState => ({
  installed: true,
  status: 'running',
  frame: { face: true, mouthOpen: 0.1, browRaise: 0, smile: 0, roll: 0, yaw: 2, pitch: 1 },
  levels: { mouthOpen: 0.2, browRaise: 0 },
  calibrating: false,
  pointer: { paused: false, nx: 0.1, ny: -0.2, deadX: 0.05, deadY: 0.05 }
})

describe('sameFaceState', () => {
  it('treats a fresh object with the same drawn fields as unchanged', () => {
    expect(sameFaceState(base(), base())).toBe(true)
    const b = base()
    b.frame = { ...b.frame!, mouthOpen: 0.4, yaw: 7 }
    expect(sameFaceState(base(), b)).toBe(true)
    expect(sameFaceState(null, base())).toBe(false)
  })

  it('sees a change in any drawn field', () => {
    const changes: ((s: FaceState) => void)[] = [
      (s) => (s.installed = false),
      (s) => (s.installing = 40),
      (s) => (s.status = 'error'),
      (s) => (s.error = 'camera busy'),
      (s) => (s.calibrating = true),
      (s) => (s.frame = null),
      (s) => (s.levels = { ...s.levels, mouthOpen: 0.3 }),
      (s) => (s.levels = { ...s.levels, smile: 0 }),
      (s) => (s.last = { gesture: 'mouthOpen', action: 'click', at: 5 }),
      (s) => (s.pointer = { ...s.pointer!, nx: 0.2 }),
      (s) => (s.pointer = { ...s.pointer!, paused: true }),
      (s) => delete s.pointer
    ]
    for (const change of changes) {
      const b = base()
      change(b)
      expect(sameFaceState(base(), b)).toBe(false)
    }
  })
})
