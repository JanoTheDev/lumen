// UIA snapshot helpers for grounding: flattening, the quality heuristic (grounding.md) that
// decides between the elements list and set-of-marks.
import type { ElementNode, Rect } from '@shared/types'
import type { UiaSnapshotResult } from '../agent/commands'

/** good: elements list only. partial: list + marks for the unnamed parts. none: marks only. */
export type UiaQuality = 'good' | 'partial' | 'none'

// Mirrors agent/uia.py INTERACTIVE (+ editable documents).
const INTERACTIVE = new Set([
  'button',
  'edit',
  'combobox',
  'checkbox',
  'radiobutton',
  'menuitem',
  'tabitem',
  'listitem',
  'treeitem',
  'hyperlink',
  'slider',
  'spinner',
  'splitbutton',
  'dataitem'
])

export function isInteractive(node: ElementNode): boolean {
  return INTERACTIVE.has(node.role) || (node.role === 'document' && node.patterns.includes('value'))
}

/** Every node below the root, document order, with its depth (root children = 0). */
export function flattenElements(root: ElementNode): { node: ElementNode; depth: number }[] {
  const out: { node: ElementNode; depth: number }[] = []
  const walk = (n: ElementNode, depth: number): void => {
    for (const c of n.children ?? []) {
      out.push({ node: c, depth })
      walk(c, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/** id → node for every node of a snapshot. */
export function elementIndex(uia: UiaSnapshotResult | undefined): Map<string, ElementNode> {
  const map = new Map<string, ElementNode>()
  if (uia) for (const { node } of flattenElements(uia.root)) map.set(node.id, node)
  return map
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Interactive, visible nodes that overlap the frame (physical px). */
export function nodesOnFrame(uia: UiaSnapshotResult | undefined, frame: Rect): ElementNode[] {
  if (!uia) return []
  return flattenElements(uia.root)
    .map((e) => e.node)
    .filter((n) => isInteractive(n) && n.rect.w > 0 && n.rect.h > 0 && intersects(n.rect, frame))
}

const GRID = 48

/** Share of `area` covered by the union of `rects`, sampled on a grid. */
export function coverage(rects: Rect[], area: Rect): number {
  if (area.w <= 0 || area.h <= 0 || !rects.length) return 0
  let hit = 0
  for (let i = 0; i < GRID; i++) {
    const y = area.y + ((i + 0.5) * area.h) / GRID
    for (let j = 0; j < GRID; j++) {
      const x = area.x + ((j + 0.5) * area.w) / GRID
      if (rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) hit++
    }
  }
  return hit / (GRID * GRID)
}

export const MIN_GOOD_NODES = 5
export const MIN_GOOD_COVERAGE = 0.3

/**
 * good: >= 5 interactive nodes on the frame and the named ones cover >= 30% of the window,
 * or the skill pack says good. A skill pack saying partial/none caps the result.
 */
export function uiaQuality(
  uia: UiaSnapshotResult | undefined,
  frame: Rect,
  windowRect?: Rect,
  skillQuality?: UiaQuality
): UiaQuality {
  if (skillQuality === 'good') return 'good'
  const nodes = nodesOnFrame(uia, frame)
  if (!nodes.length) return 'none'
  if (skillQuality) return skillQuality === 'none' ? 'none' : 'partial'
  const area = windowRect ?? uia?.root.rect ?? frame
  const named = nodes.filter((n) => n.name.trim()).map((n) => n.rect)
  return nodes.length >= MIN_GOOD_NODES && coverage(named, area) >= MIN_GOOD_COVERAGE
    ? 'good'
    : 'partial'
}
