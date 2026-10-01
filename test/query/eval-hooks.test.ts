import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import { setScreenAdapter } from '../../src/main/actions/coords'
import { groundOnly } from '../../src/main/query/eval-hooks'
import { display, screenAdapterFor } from '../helpers/displays'

afterEach(() => setScreenAdapter(null))

describe('groundOnly', () => {
  it('resolves the picked target against a recorded frame, headless', async () => {
    setScreenAdapter(
      screenAdapterFor({
        name: '150%',
        displays: [
          display('m', { x: 0, y: 0, width: 2880, height: 1800 }, 1.5, { x: 0, y: 0 }, true)
        ]
      })
    )
    const monitor = { id: 0, rect: { x: 0, y: 0, w: 2880, h: 1800 }, scale: 1.5, primary: true }
    const uia = {
      snapshotId: 's',
      root: {
        id: 'e0',
        role: 'window',
        name: 'Mail',
        rect: monitor.rect,
        monitorId: 0,
        enabled: true,
        patterns: [],
        children: [
          {
            id: 'e1',
            role: 'button',
            name: 'Compose',
            rect: { x: 30, y: 270, w: 210, h: 90 },
            monitorId: 0,
            enabled: true,
            patterns: ['invoke' as const]
          }
        ]
      }
    }
    const pick = vi.fn(async () => ({ kind: 'element' as const, id: 'e1' }))
    const r = await groundOnly(
      { data: 'jpg', width: 1280, height: 800, monitor },
      uia,
      undefined,
      'click compose',
      pick
    )
    expect(pick).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'click compose',
        elements: 'e1 button "Compose" @(13,120,93,40)'
      })
    )
    expect(r).toMatchObject({ elementId: 'e1', logicalRect: { x: 20, y: 180, w: 140, h: 60 } })
  })
})
