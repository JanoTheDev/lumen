// Labeling flow (11 T13) without Electron: find the unnamed controls of the foreground window,
// crop each from one screenshot, ask the vision model once for all of them, keep the answers
// in the local store; look a control up again by automation id or icon hash. Points and rects
// are physical px.
import type { ElementNode, Point, Rect } from '@shared/types'
import type { GrayImage } from '../ai/frames'
import { flattenElements } from '../query/uia-list'
import { isGenericName, isUnnamed, neighbours, unnamedNodes } from './detect'
import { iconHash } from './hash'
import { LABEL_SYSTEM, labelTurn, readReply, type LabelReply } from './prompt'
import { labelKey, type LabelEntry, type LabelStore } from './store'

/** Controls named per request (one model call). */
export const MAX_PER_CALL = 16

export interface LabelWindow {
  title: string
  rect: Rect
  process?: string
}

export interface LabelApp {
  id: string
  name: string
}

export interface LabelFrame {
  data: string
  width: number
  /** Physical rect the image shows. */
  region: Rect
}

export interface LabelerDeps {
  window(): Promise<LabelWindow | null>
  appOf(w: LabelWindow): LabelApp | null
  snapshot(): Promise<ElementNode | null>
  capture(region: Rect): Promise<LabelFrame | null>
  crop(b64: string, rect: Rect): string | null
  gray(b64: string): GrayImage | null
  hasModel(): boolean
  complete(system: string, user: string, images: string[]): Promise<LabelReply | null>
  store: LabelStore
  log(msg: string): void
}

/** A physical rect as image px of `f`. */
export function toImageRect(f: LabelFrame, r: Rect): Rect {
  const s = f.region.w / f.width || 1
  return { x: (r.x - f.region.x) / s, y: (r.y - f.region.y) / s, w: r.w / s, h: r.h / s }
}

/** `r` grown by a margin (icons need their surroundings to make sense). */
export function padded(r: Rect, min = 12): Rect {
  const m = Math.max(min, Math.round(Math.max(r.w, r.h) * 0.4))
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m }
}

const ROLE_WORD: Record<string, string> = {
  menuitem: 'menu item',
  tabitem: 'tab',
  splitbutton: 'button',
  checkbox: 'check box',
  radiobutton: 'radio button',
  hyperlink: 'link',
  combobox: 'combo box'
}
export const roleWord = (role: string): string => ROLE_WORD[role] ?? role

/** "Render, button. Renders the current frame. Label made by AI, not checked yet." */
export function spokenLabel(l: LabelEntry): string {
  const who =
    l.source === 'human'
      ? ''
      : l.confidence < 0.5
        ? ' Label guessed by AI, it may be wrong.'
        : ' Label made by AI.'
  return `${l.label}, ${roleWord(l.role)}.${l.description ? ` ${l.description}` : ''}${who}`
}

/** The smallest control under `p` (deepest first on ties). */
export function nodeAt(root: ElementNode, p: Point): ElementNode | null {
  let best: { n: ElementNode; area: number; depth: number } | null = null
  for (const { node, depth } of flattenElements(root)) {
    const r = node.rect
    if (p.x < r.x || p.y < r.y || p.x >= r.x + r.w || p.y >= r.y + r.h) continue
    const area = r.w * r.h
    if (!best || area < best.area || (area === best.area && depth > best.depth))
      best = { n: node, area, depth }
  }
  return best?.n ?? null
}

export type LabelResult =
  | { ok: true; app: LabelApp; named: number; asked: number; known: number }
  | {
      ok: false
      reason: 'no-window' | 'no-model' | 'none' | 'all-known' | 'failed'
      app?: LabelApp
      known?: number
    }

export interface Labeler {
  labelWindow(signal?: AbortSignal): Promise<LabelResult>
  /** What the label store says about the control at `p`; null when it is named or unknown. */
  labelAt(p: Point): Promise<string | null>
  /** Saves `label` (human) for the control at `p`. */
  nameAt(p: Point, label: string): Promise<{ ok: boolean; app?: LabelApp; why?: string }>
}

export function createLabeler(deps: LabelerDeps): Labeler {
  const hashOf = (frame: LabelFrame, n: ElementNode): string | null => {
    const tight = deps.crop(frame.data, toImageRect(frame, n.rect))
    return tight ? iconHash(deps.gray(tight)) : null
  }

  async function target(
    p: Point
  ): Promise<{ app: LabelApp; node: ElementNode; hash: string | null } | null> {
    const w = await deps.window()
    const app = w && deps.appOf(w)
    const root = app ? await deps.snapshot() : null
    const node = root ? nodeAt(root, p) : null
    if (!app || !node || !isUnnamed(node)) return null
    let hash: string | null = null
    if (!node.automationId) {
      const frame = await deps.capture(padded(node.rect))
      hash = frame ? hashOf(frame, node) : null
    }
    return { app, node, hash }
  }

  return {
    async labelWindow(signal) {
      const w = await deps.window()
      const app = w && deps.appOf(w)
      if (!w || !app) return { ok: false, reason: 'no-window' }
      if (!deps.hasModel()) return { ok: false, reason: 'no-model', app }
      const root = await deps.snapshot()
      const nodes = root ? unnamedNodes(root, 60) : []
      if (!root || !nodes.length) return { ok: false, reason: 'none', app }
      const frame = await deps.capture(w.rect)
      if (!frame || signal?.aborted) return { ok: false, reason: 'failed', app }
      let known = 0
      const todo: { node: ElementNode; hash: string | null; crop: string }[] = []
      for (const node of nodes) {
        if (todo.length >= MAX_PER_CALL) break
        const hash = hashOf(frame, node)
        const q = { role: node.role, automationId: node.automationId, iconHash: hash }
        if (deps.store.find(app.id, q)) {
          known++
          continue
        }
        if (!node.automationId && !hash) continue
        const crop = deps.crop(frame.data, padded(toImageRect(frame, node.rect)))
        if (crop) todo.push({ node, hash, crop })
      }
      if (!todo.length) return { ok: false, reason: known ? 'all-known' : 'none', app, known }
      const user = labelTurn(
        app.name,
        w.title,
        todo.map((t, i) => ({ n: i + 1, role: t.node.role, near: neighbours(root, t.node) }))
      )
      const reply = await deps
        .complete(
          LABEL_SYSTEM,
          user,
          todo.map((t) => t.crop)
        )
        .catch((e: Error) => {
          deps.log(`labels: model call failed (${e.message})`)
          return null
        })
      if (signal?.aborted) return { ok: false, reason: 'failed', app }
      const got = readReply(reply, todo.length)
      const entries: LabelEntry[] = []
      for (const [n, l] of got) {
        const { node, hash } = todo[n - 1]
        entries.push({
          role: node.role,
          ...(node.automationId ? { automationId: node.automationId } : {}),
          ...(hash ? { iconHash: hash } : {}),
          label: l.label,
          ...(l.description ? { description: l.description } : {}),
          source: 'ai',
          confidence: l.confidence
        })
      }
      const named = deps.store.put(app.id, app.name, entries)
      deps.log(`labels: ${named} of ${todo.length} controls named in ${app.id}`)
      return { ok: true, app, named, asked: todo.length, known }
    },

    async labelAt(p) {
      const t = await target(p).catch(() => null)
      if (!t) return null
      const hit = deps.store.find(t.app.id, {
        role: t.node.role,
        automationId: t.node.automationId,
        iconHash: t.hash
      })
      return hit ? spokenLabel(hit) : null
    },

    async nameAt(p, label) {
      const text = label.replace(/\s+/g, ' ').trim().slice(0, 60)
      if (!text || isGenericName(text)) return { ok: false, why: 'That name is too short.' }
      const t = await target(p).catch(() => null)
      if (!t)
        return {
          ok: false,
          why: 'The control under the pointer already has a name, or I cannot find one.'
        }
      if (!t.node.automationId && !t.hash)
        return { ok: false, app: t.app, why: 'I cannot tell this control apart from others.' }
      const entry: LabelEntry = {
        role: t.node.role,
        ...(t.node.automationId ? { automationId: t.node.automationId } : {}),
        ...(t.hash ? { iconHash: t.hash } : {}),
        label: text,
        source: 'human',
        confidence: 1
      }
      deps.store.put(t.app.id, t.app.name, [entry])
      deps.log(`labels: ${labelKey(entry)} named by the user in ${t.app.id}`)
      return { ok: true, app: t.app }
    }
  }
}
