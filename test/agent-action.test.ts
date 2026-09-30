import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))

import { toAgentAction } from '../src/main/actions/agent-action'
import type { FrameGeometry } from '../src/main/actions/coords'

// 2560x1440 physical display, image downscaled to 1280x720 → factor 2.
const frame: FrameGeometry = {
  originX: 0,
  originY: 0,
  width: 2560,
  height: 1440,
  imgW: 1280,
  imgH: 720
}

describe('toAgentAction', () => {
  it('scales click points to physical px', () => {
    expect(toAgentAction({ type: 'click', x: 100, y: 50, button: 'left' }, frame)).toEqual({
      type: 'click',
      x: 200,
      y: 100,
      button: 'left'
    })
  })

  it('turns click_bbox into a click at the physical center', () => {
    expect(
      toAgentAction(
        { type: 'click_bbox', bbox: { x: 10, y: 20, w: 30, h: 40 }, description: 'x' },
        frame
      )
    ).toEqual({
      type: 'click',
      x: 50,
      y: 80,
      button: 'left'
    })
  })

  it('sends click_element bbox as physical x1,y1,x2,y2 for the agent', () => {
    const a = toAgentAction(
      { type: 'click_element', text: 'Save', bbox: { x: 10, y: 20, w: 30, h: 40 } },
      frame
    )
    expect(a.bbox).toEqual([20, 40, 80, 120])
  })

  it('caps scroll amount and scales its point', () => {
    expect(
      toAgentAction({ type: 'scroll', direction: 'down', amount: 9, x: 5, y: 5 }, frame)
    ).toEqual({
      type: 'scroll',
      direction: 'down',
      amount: 2,
      x: 10,
      y: 10
    })
  })

  it('offsets by the monitor origin', () => {
    const second = { ...frame, originX: 2560 }
    expect(toAgentAction({ type: 'move', x: 0, y: 0 }, second)).toEqual({
      type: 'move',
      x: 2560,
      y: 0
    })
  })
})
