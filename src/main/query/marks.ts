// Set-of-marks (T15): numbered boxes drawn onto the screenshot when UIA is poor, so the model
// can answer {kind:"mark", n}. Sources: UIA nodes the elements list cannot name, OCR lines,
// (later) skill regions; deduped by IoU and numbered in reading order. The table is kept per
// turn on the QueryContext for resolveTarget and 06's "show numbers".
import type { ElementNode, Rect } from '@shared/types'
import type { OcrWord } from '../agent/commands'
import { sortReading } from './nth'
import type { UiaQuality } from './uia-list'

export type MarkSource = 'uia' | 'ocr' | 'region'

export interface Mark {
  n: number
  /** Physical px. */
  physRect: Rect
  source: MarkSource
  label: string
  elementId?: string
}

export type MarksTable = Mark[]

export const MAX_MARKS = 120
const MIN_SIDE = 6
// Boxes bigger than this share of the frame are panes, not targets.
const MAX_AREA_SHARE = 0.25
const DUP_IOU = 0.5

export function iou(a: Rect, b: Rect): number {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (ix <= 0 || iy <= 0) return 0
  const inter = ix * iy
  return inter / (a.w * a.h + b.w * b.h - inter)
}

export interface MarksInput {
  /** Interactive UIA nodes on the frame. */
  nodes: ElementNode[]
  ocrLines: OcrWord[]
  /** Physical rect of the frame. */
  frame: Rect
  quality: UiaQuality
  max?: number
}

/**
 * none: every UIA node and OCR line gets a mark. partial: only unnamed UIA nodes and OCR
 * lines that are not already a named element (those are in the elements list).
 */
export function buildMarks(input: MarksInput): MarksTable {
  const { frame, quality } = input
  const frameArea = frame.w * frame.h
  const usable = (r: Rect): boolean => {
    if (r.w < MIN_SIDE || r.h < MIN_SIDE || r.w * r.h > frameArea * MAX_AREA_SHARE) return false
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    return cx >= frame.x && cx < frame.x + frame.w && cy >= frame.y && cy < frame.y + frame.h
  }
  const named = quality === 'partial' ? input.nodes.filter((n) => n.name.trim()) : []
  const candidates: Omit<Mark, 'n'>[] = []
  for (const node of input.nodes) {
    if (quality === 'partial' && node.name.trim()) continue
    candidates.push({
      physRect: node.rect,
      source: 'uia',
      label: node.name.trim() || node.role,
      elementId: node.id
    })
  }
  for (const line of input.ocrLines) {
    const text = line.text.trim()
    if (!text || named.some((n) => iou(n.rect, line.rect) > DUP_IOU)) continue
    candidates.push({ physRect: line.rect, source: 'ocr', label: text })
  }
  const kept: Omit<Mark, 'n'>[] = []
  for (const c of candidates) {
    if (!usable(c.physRect)) continue
    if (kept.some((k) => iou(k.physRect, c.physRect) > DUP_IOU)) continue
    kept.push(c)
  }
  return sortReading(kept, (m) => m.physRect)
    .slice(0, input.max ?? MAX_MARKS)
    .map((m, i) => ({ ...m, n: i + 1 }))
}

export function findMark(table: MarksTable | undefined, n: number): Mark | undefined {
  return table?.find((m) => m.n === n)
}
