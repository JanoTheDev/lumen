// Converts model actions (image px, Rect bboxes) into what the agent executes
// (physical px; click_element bbox as [x1,y1,x2,y2]).
import { imageToPhys, imageRectToPhys, rectCenter, type FrameGeometry, type Rect } from './coords'

export interface AgentAction {
  type: string
  x?: number
  y?: number
  bbox?: [number, number, number, number]
  button?: 'left' | 'right'
  text?: string
  keys?: string[]
  url?: string
  n?: number
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
}

export interface ModelAction {
  type: string
  x?: number
  y?: number
  bbox?: Rect
  button?: 'left' | 'right'
  text?: string
  keys?: string[]
  url?: string
  n?: number
  description?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
}

// Cap model-chosen scroll amounts; bigger jumps overshoot the target content.
const MAX_SCROLL = 2

export function toAgentAction(action: ModelAction, frame: FrameGeometry): AgentAction {
  const { bbox, ...rest } = action
  delete rest.description
  const base: AgentAction = { ...rest }
  const hasPoint = action.x != null && action.y != null

  switch (action.type) {
    case 'scroll': {
      base.amount = action.amount != null ? Math.min(Math.max(1, action.amount), MAX_SCROLL) : 1
      if (hasPoint) Object.assign(base, imageToPhys(frame, { x: action.x!, y: action.y! }))
      return base
    }
    case 'click':
    case 'move':
      if (hasPoint) Object.assign(base, imageToPhys(frame, { x: action.x!, y: action.y! }))
      return base
    case 'click_bbox': {
      if (!bbox) return base
      const c = rectCenter(imageRectToPhys(frame, bbox))
      return {
        type: 'click',
        x: Math.round(c.x),
        y: Math.round(c.y),
        button: action.button ?? 'left'
      }
    }
    case 'click_element': {
      if (bbox) {
        const r = imageRectToPhys(frame, bbox)
        base.bbox = [r.x, r.y, r.x + r.w, r.y + r.h]
      }
      return base
    }
    default:
      return base
  }
}
