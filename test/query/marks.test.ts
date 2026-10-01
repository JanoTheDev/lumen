import { describe, expect, it } from 'vitest'
import type { ElementNode, Rect } from '@shared/types'
import { buildMarks, findMark, iou } from '../../src/main/query/marks'
import { userTurn } from '../../src/main/ai/prompts/assemble'

const FRAME: Rect = { x: -1920, y: 0, w: 1920, h: 1080 }

function node(id: string, name: string, rect: Rect): ElementNode {
  return { id, role: 'button', name, rect, monitorId: 0, enabled: true, patterns: ['invoke'] }
}

const line = (text: string, rect: Rect): { text: string; rect: Rect; conf: number } => ({
  text,
  rect,
  conf: 1
})

describe('iou', () => {
  it('is 1 for identical, 0 for disjoint, partial otherwise', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    expect(iou(a, a)).toBe(1)
    expect(iou(a, { x: 20, y: 0, w: 10, h: 10 })).toBe(0)
    expect(iou(a, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(50 / 150)
  })
})

describe('buildMarks', () => {
  it('numbers UIA nodes and OCR lines in reading order (none quality)', () => {
    const marks = buildMarks({
      quality: 'none',
      frame: FRAME,
      nodes: [node('e3', '', { x: -1800, y: 400, w: 60, h: 30 })],
      ocrLines: [
        line('Render', { x: -1000, y: 20, w: 80, h: 20 }),
        line('File', { x: -1900, y: 22, w: 40, h: 18 })
      ]
    })
    expect(marks.map((m) => [m.n, m.label, m.source])).toEqual([
      [1, 'File', 'ocr'],
      [2, 'Render', 'ocr'],
      [3, 'button', 'uia']
    ])
    expect(marks[2].elementId).toBe('e3')
    expect(findMark(marks, 2)?.physRect).toEqual({ x: -1000, y: 20, w: 80, h: 20 })
    expect(findMark(marks, 9)).toBeUndefined()
  })

  it('partial: skips named nodes and OCR lines that duplicate them', () => {
    const marks = buildMarks({
      quality: 'partial',
      frame: FRAME,
      nodes: [
        node('e1', 'Save', { x: -1900, y: 10, w: 60, h: 24 }),
        node('e2', '', { x: -1500, y: 10, w: 60, h: 24 })
      ],
      ocrLines: [
        line('Save', { x: -1898, y: 12, w: 56, h: 20 }),
        line('Viewport', { x: -1200, y: 300, w: 120, h: 20 })
      ]
    })
    expect(marks.map((m) => m.label)).toEqual(['button', 'Viewport'])
  })

  it('dedupes by IoU, drops panes, tiny and off-frame boxes, and caps the count', () => {
    const marks = buildMarks({
      quality: 'none',
      frame: FRAME,
      nodes: [
        node('e1', 'Pane', { x: -1920, y: 0, w: 1900, h: 1000 }),
        node('e2', 'Tiny', { x: -1000, y: 500, w: 4, h: 4 }),
        node('e3', 'Other screen', { x: 100, y: 10, w: 50, h: 20 }),
        node('e4', 'OK', { x: -500, y: 500, w: 60, h: 30 })
      ],
      ocrLines: [line('OK', { x: -498, y: 502, w: 58, h: 28 })]
    })
    expect(marks.map((m) => m.label)).toEqual(['OK'])
    expect(marks[0].source).toBe('uia')

    const many = Array.from({ length: 200 }, (_, i) =>
      line(`row ${i}`, { x: -1900, y: i * 5, w: 100, h: 8 })
    )
    expect(
      buildMarks({ quality: 'none', frame: FRAME, nodes: [], ocrLines: many, max: 120 })
    ).toHaveLength(120)
  })
})

describe('user turn', () => {
  it('tells the model about the marks', () => {
    const turn = userTurn({
      prompt: 'click render',
      activeWindow: 'Blender',
      frame: { w: 1280, h: 720 },
      marks: 42,
      now: new Date(0)
    })
    expect(turn).toContain('marks: 42 numbered boxes drawn on frame "1"')
    expect(turn).toContain('{"kind":"mark","n":N}')
  })
})
