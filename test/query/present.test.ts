import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: {} }))
const send = vi.fn()
vi.mock('../../src/main/windows/highlight', () => ({
  send: (...a: unknown[]) => send(...a),
  show: vi.fn(),
  clear: vi.fn()
}))
const showText = vi.fn()
vi.mock('../../src/main/windows/answer', () => ({ showText: (t: string) => showText(t) }))
vi.mock('../../src/main/windows/status', () => ({ setStatus: vi.fn() }))

import type { MonitorInfo } from '@shared/types'
import { frameGeometryOf, setScreenAdapter } from '../../src/main/actions/coords'
import { present } from '../../src/main/query/present'
import type { GroundingContext } from '../../src/main/query/resolve-target'
import { display, screenAdapterFor } from '../helpers/displays'

const MON: MonitorInfo = {
  id: 0,
  rect: { x: 0, y: 0, w: 2880, h: 1800 },
  scale: 1.5,
  primary: true
}
const LAYOUT = {
  name: '150%',
  displays: [display('m', { x: 0, y: 0, width: 2880, height: 1800 }, 1.5, { x: 0, y: 0 }, true)]
}

const ctx: GroundingContext = {
  frames: [
    {
      label: '1',
      monitor: MON,
      geometry: frameGeometryOf({ width: 1280, height: 800, monitor: MON })
    }
  ],
  uia: {
    snapshotId: 's',
    root: {
      id: 'e0',
      role: 'window',
      name: 'w',
      rect: MON.rect,
      monitorId: 0,
      enabled: true,
      patterns: [],
      children: [
        {
          id: 'e2',
          role: 'tabitem',
          name: 'Inbox',
          rect: { x: 150, y: 300, w: 300, h: 60 },
          monitorId: 0,
          enabled: true,
          patterns: ['select']
        }
      ]
    }
  },
  ocr: async () => ({
    words: [{ text: 'Settings', rect: { x: 1500, y: 90, w: 150, h: 30 }, conf: 1, lineIndex: 0 }],
    lines: []
  })
}

beforeEach(() => {
  setScreenAdapter(screenAdapterFor(LAYOUT))
  send.mockClear()
  showText.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  setScreenAdapter(null)
  vi.restoreAllMocks()
})

describe('present', () => {
  it('locate: resolves element targets to logical boxes', async () => {
    await present(
      { mode: 'locate', items: [{ label: 'Inbox', target: { kind: 'element', id: 'e2' } }] },
      'where is inbox',
      vi.fn(),
      ctx
    )
    expect(send).toHaveBeenCalledWith('screen:locate', [
      expect.objectContaining({ label: 'Inbox', bbox: { x: 100, y: 200, w: 200, h: 40 } })
    ])
  })

  it('locate: answers with the reason when nothing resolves', async () => {
    await present(
      {
        mode: 'locate',
        items: [{ label: 'x', target: { kind: 'element', id: 'gone' } }],
        notFoundReason: 'It is in the sidebar, scrolled away.'
      },
      'q',
      vi.fn(),
      ctx
    )
    expect(showText).toHaveBeenCalledWith('It is in the sidebar, scrolled away.')
  })

  it('guide: text targets resolve through OCR and the pointer starts on step 1', async () => {
    const onGuide = vi.fn()
    await present(
      {
        mode: 'guide',
        steps: [
          {
            label: 'Open Settings',
            target_hint: 'Settings',
            target: { kind: 'text', text: 'Settings' }
          },
          { label: 'Legacy box', target_hint: '', bbox: { x: 0, y: 0, w: 128, h: 80 } }
        ]
      },
      'how do I change settings',
      onGuide,
      ctx
    )
    const steps = onGuide.mock.calls[0][1]
    expect(steps[0].bbox).toEqual({ x: 1000, y: 60, w: 100, h: 20 })
    expect(steps[1].bbox).toEqual({ x: 0, y: 0, w: 192, h: 120 })
    expect(send).toHaveBeenCalledWith('screen:pointer', expect.objectContaining({ x: 1050, y: 70 }))
  })
})
