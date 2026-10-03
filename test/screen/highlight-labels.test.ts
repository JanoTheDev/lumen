// Highlight label placement is computed once per scene in ScreenApp and shared by the label
// layer and the buddy (12 T14). Render counts per cursor move need a DOM and are a hand test.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spy = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../src/renderer/src/screen/labels', async (orig) => {
  const real = await orig<typeof import('../../src/renderer/src/screen/labels')>()
  return {
    ...real,
    placeLabels: (...args: Parameters<typeof real.placeLabels>) => {
      spy.calls++
      return real.placeLabels(...args)
    }
  }
})

import type { Rect } from '@shared/types'
import type { Present } from '../../src/renderer/src/screen/scene'
import {
  buddyAvoid,
  placeHighlightLabels,
  type Highlight
} from '../../src/renderer/src/screen/highlight-labels'
import { HighlightLabels } from '../../src/renderer/src/screen/Highlights'

const view = { w: 1920, h: 1080 }
const hl = (id: string, rect: Rect, label?: string, n?: number): Highlight => ({
  id,
  rect,
  style: 'target',
  label,
  n
})
const present = (items: Highlight[]): Present<Highlight>[] =>
  items.map((item) => ({ key: item.id, item, exiting: false, since: 0 }))

const items = [
  hl('h0', { x: 100, y: 100, w: 80, h: 30 }, 'Compose', 1),
  hl('h1', { x: 200, y: 100, w: 80, h: 30 }, 'Send the message now', 2),
  hl('h2', { x: 1850, y: 1040, w: 60, h: 30 }, 'Corner'),
  hl('h3', { x: 600, y: 600, w: 40, h: 40 })
]

describe('highlight label placement (12 T14)', () => {
  beforeEach(() => {
    spy.calls = 0
  })

  it('places the pills where it always did', () => {
    const placed = placeHighlightLabels({ list: present(items), view, fontPx: 16 })
    expect(Object.fromEntries(placed)).toMatchInlineSnapshot(`
      {
        "h0": {
          "h": 33,
          "w": 83,
          "x": 94,
          "y": 144,
        },
        "h1": {
          "h": 33,
          "w": 200,
          "x": 194,
          "y": 144,
        },
        "h2": {
          "h": 33,
          "w": 74,
          "x": 1844,
          "y": 993,
        },
      }
    `)
    expect(spy.calls).toBe(1)
  })

  it('leaves out the label the buddy already says', () => {
    const placed = placeHighlightLabels({
      list: present(items),
      buddyLabel: 'Compose',
      view,
      fontPx: 16
    })
    expect([...placed.keys()]).not.toContain('h0')
  })

  it('builds the buddy avoid list from the target, other rects and the placed pills', () => {
    const placed = placeHighlightLabels({ list: present(items), view, fontPx: 16 })
    const target = items[1].rect
    expect(buddyAvoid(items, target, placed)).toEqual([
      items[0].rect,
      items[2].rect,
      items[3].rect,
      ...placed.values()
    ])
    expect(buddyAvoid([], undefined, new Map())).toEqual([])
  })

  it('the label layer draws the pills it is given without placing them again', () => {
    const list = present(items)
    const placed = placeHighlightLabels({ list, view, fontPx: 16 })
    spy.calls = 0
    const html = renderToStaticMarkup(
      createElement(HighlightLabels, { list, view, fontPx: 16, placed })
    )
    expect(spy.calls).toBe(0)
    const h1 = placed.get('h1')!
    expect(html).toContain(`translate(${h1.x}px, ${h1.y}px)`)
    expect(html).toContain('Send the message now')
    expect(html.match(/sl-badge/g)).toHaveLength(2)
  })
})
