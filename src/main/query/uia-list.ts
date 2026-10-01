// UIA snapshot helpers for grounding: flattening, the quality heuristic (grounding.md) that
// decides between the elements list and set-of-marks, and the compact list for the prompt.
import type { ElementNode, Rect } from '@shared/types'
import type { UiaSnapshotResult } from '../agent/commands'
import { physRectToImage, type FrameGeometry } from '../actions/coords'

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

// ---- Compact elements list for the user turn (T16, CONTRACTS C3) ----

export const MAX_LIST_NODES = 400
export const LIST_NAME_MAX = 60
/** Token budget for the list; nodes past it are dropped (document order). */
export const LIST_TOKEN_BUDGET = 3000
const VALUE_MAX = 40
const REDACTED = '<redacted>'
// Field names whose values are never shown, on top of the agent's IsPassword redaction.
const SECRET_RE =
  /pass(word|code|phrase)?|\bpin\b|secret|one[- ]time|\botp\b|security code|\bcvv\b|\bcvc\b|card number/i

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').replace(/"/g, "'").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function valueOf(node: ElementNode): string | null {
  if (node.value === undefined || !node.patterns.includes('value')) return null
  if (!node.value) return ''
  if (/^•+$/.test(node.value) || SECRET_RE.test(`${node.name} ${node.automationId ?? ''}`))
    return REDACTED
  return clip(node.value, VALUE_MAX)
}

export interface ElementsList {
  text: string
  count: number
  /** Rough token estimate (chars / 3.5). */
  tokens: number
  /** Nodes left out by the node cap or the token budget. */
  truncated: boolean
}

/**
 * One line per interactive node on the frame, indented by depth among the kept nodes:
 * `e42 button "Compose" @(12,180,96,36)` with the rect in image px of the frame.
 */
export function serializeElements(
  uia: UiaSnapshotResult | undefined,
  frame: FrameGeometry,
  max = MAX_LIST_NODES,
  tokenBudget = LIST_TOKEN_BUDGET
): ElementsList | null {
  if (!uia) return null
  const frameRect = { x: frame.originX, y: frame.originY, w: frame.width, h: frame.height }
  const lines: string[] = []
  const budget = tokenBudget * 3.5
  let chars = 0
  let truncated = false
  const walk = (n: ElementNode, depth: number): void => {
    for (const c of n.children ?? []) {
      if (truncated) return
      const keep = isInteractive(c) && c.rect.w > 0 && c.rect.h > 0 && intersects(c.rect, frameRect)
      if (keep) {
        const r = physRectToImage(frame, c.rect)
        const value = valueOf(c)
        const flags = [
          c.enabled ? '' : ' disabled',
          c.focused ? ' focused' : '',
          value === null ? '' : ` value="${value}"`
        ].join('')
        const line = `${'  '.repeat(depth)}${c.id} ${c.role} "${clip(c.name, LIST_NAME_MAX)}" @(${r.x},${r.y},${r.w},${r.h})${flags}`
        if (lines.length >= max || chars + line.length + 1 > budget) {
          truncated = true
          return
        }
        lines.push(line)
        chars += line.length + 1
      }
      walk(c, keep ? depth + 1 : depth)
    }
  }
  walk(uia.root, 0)
  if (!lines.length) return null
  const text = lines.join('\n')
  return { text, count: lines.length, tokens: Math.ceil(text.length / 3.5), truncated }
}
