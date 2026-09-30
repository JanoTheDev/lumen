interface Bbox { x: number; y: number; w: number; h: number }
interface HighlightStep { bbox?: Bbox; label?: string; target_hint?: string }
interface LocateItem { label: string; bbox: Bbox; description?: string }
interface HighlightApi {
  onShowHighlights?: (cb: (steps: unknown[]) => void) => void
  onClearHighlights?: (cb: () => void) => void
  onShowPointer?: (cb: (data: { x: number; y: number; text: string }) => void) => void
  onShowLocate?: (cb: (items: LocateItem[]) => void) => void
}

const api = (window as unknown as { api?: HighlightApi }).api

const canvas = document.getElementById('c') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
canvas.width = window.screen.width
canvas.height = window.screen.height

let domElements: HTMLElement[] = []
function clearDom(): void { domElements.forEach(el => el.remove()); domElements = [] }
function addEl(el: HTMLElement): void { document.body.appendChild(el); domElements.push(el) }

function drawHighlights(steps: HighlightStep[]): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  clearDom()

  steps.forEach((step, i) => {
    if (!step.bbox) return
    const { x, y, w, h } = step.bbox
    const cx = x + w / 2
    const cy = y + h / 2

    // highlight rect — subtle fill + clean border
    ctx.strokeStyle = 'rgba(0,0,0,0.22)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.strokeRect(x + 0.5, y + 0.5, w, h)
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(0,0,0,0.04)'
    ctx.fillRect(x, y, w, h)

    // pulse ring + dot
    const ring = document.createElement('div')
    ring.className = 'pulse-ring'
    ring.style.cssText = `left:${cx-13}px;top:${cy-13}px;width:26px;height:26px;animation-delay:${i * 0.15}s`
    addEl(ring)

    const dot = document.createElement('div')
    dot.className = 'pulse-dot'
    dot.style.cssText = `left:${cx-4}px;top:${cy-4}px`
    addEl(dot)

    // label
    const label = document.createElement('div')
    label.className = 'label'
    const num = document.createElement('span')
    num.className = 'step-num'
    num.textContent = String(i + 1)
    label.appendChild(num)
    label.appendChild(document.createTextNode(step.label || step.target_hint || ''))

    const labelY = (y + h + 10 < window.screen.height - 40) ? (y + h + 10) : (y - 52)
    const labelX = Math.min(x, window.screen.width - 260)
    label.style.cssText = `left:${labelX}px;top:${labelY}px`
    addEl(label)
  })
}

function showPointer(x: number, y: number, text: string): void {
  clearDom()
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const ring = document.createElement('div')
  ring.className = 'pulse-ring'
  ring.style.cssText = `left:${x-14}px;top:${y-14}px;width:28px;height:28px`
  addEl(ring)

  const dot = document.createElement('div')
  dot.className = 'pulse-dot'
  dot.style.cssText = `left:${x-4}px;top:${y-4}px`
  addEl(dot)

  if (text) {
    const label = document.createElement('div')
    label.className = 'pointer-label'
    const m = /^(\d+\/\d+):\s*(.*)$/.exec(text)
    if (m) {
      const num = document.createElement('span')
      num.className = 'num'
      num.textContent = m[1]
      label.appendChild(num)
      label.appendChild(document.createTextNode(m[2]))
    } else {
      label.textContent = text
    }
    // Temporarily place off-screen to measure, then position
    label.style.cssText = 'left:-9999px;top:-9999px'
    addEl(label)
    const lw = label.offsetWidth
    const lh = label.offsetHeight
    // Prefer right of cursor; flip left if no room. Vertically center on cursor with clamp.
    let lx = x + 24
    if (lx + lw + 12 > window.screen.width) lx = Math.max(8, x - lw - 24)
    let ly = y - Math.round(lh / 2)
    ly = Math.max(8, Math.min(ly, window.screen.height - lh - 8))
    label.style.cssText = `left:${lx}px;top:${ly}px`
  }
}

function clearAll(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  clearDom()
}

function unionBbox(a: Bbox, b: Bbox): Bbox {
  const minX = Math.min(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxX = Math.max(a.x + a.w, b.x + b.w)
  const maxY = Math.max(a.y + a.h, b.y + b.h)
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// Merge items whose bboxes overlap or are within `gap` pixels of each other
function mergeAdjacent(items: LocateItem[], gap: number): LocateItem[] {
  if (items.length <= 1) return items
  const result = items.map(i => ({ ...i, bbox: { ...i.bbox } }))
  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const { x: ax, y: ay, w: aw, h: ah } = result[i].bbox
        const { x: bx, y: by, w: bw, h: bh } = result[j].bbox
        const xClose = ax < bx + bw + gap && ax + aw + gap > bx
        const yClose = ay < by + bh + gap && ay + ah + gap > by
        if (xClose && yClose) {
          result[i].bbox = unionBbox(result[i].bbox, result[j].bbox)
          result.splice(j, 1)
          changed = true
          break outer
        }
      }
    }
  }
  return result
}

function showLocate(rawItems: LocateItem[]): void {
  const items = mergeAdjacent(rawItems, 4)
  clearDom()
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // Single dim pass over entire screen
  ctx.fillStyle = 'rgba(0,0,0,0.60)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const pad = 8

  items.forEach(({ label, bbox, description }) => {
    const { x, y, w, h } = bbox

    // Punch hole to reveal element
    ctx.clearRect(x - pad, y - pad, w + pad * 2, h + pad * 2)

    // Border
    const bx = x - pad + 0.5, by = y - pad + 0.5
    const bw = w + pad * 2 - 1, bh = h + pad * 2 - 1
    ctx.strokeStyle = 'rgba(66,153,225,0.85)'
    ctx.lineWidth = 2.5
    ctx.setLineDash([])
    ctx.strokeRect(bx, by, bw, bh)

    // Corner brackets for large components
    if (w > 100 || h > 70) {
      const cLen = Math.min(20, w * 0.14, h * 0.14)
      ctx.strokeStyle = 'rgba(66,153,225,0.9)'
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(bx, by + cLen); ctx.lineTo(bx, by); ctx.lineTo(bx + cLen, by); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(bx + bw - cLen, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + cLen); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(bx, by + bh - cLen); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + cLen, by + bh); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(bx + bw - cLen, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - cLen); ctx.stroke()
    }

    // Label — outside, anchored to top edge of box (above if room, below if near screen top)
    const labelEl = document.createElement('div')
    labelEl.className = 'locate-label'
    const dot = document.createElement('span')
    dot.className = 'locate-dot'
    labelEl.appendChild(dot)
    labelEl.appendChild(document.createTextNode(description || label))
    const labelX = Math.max(8, Math.min(x - pad, canvas.width - 296))
    const aboveRoom = y - pad > 60
    const labelY = aboveRoom ? (y - pad - 6) : (y + h + pad + 10)
    labelEl.style.cssText = `left:${labelX}px;top:${labelY}px${aboveRoom ? ';transform:translateY(-100%)' : ''}`
    addEl(labelEl)
  })
}

if (api) {
  api.onShowHighlights?.((steps) => drawHighlights(steps as HighlightStep[]))
  api.onClearHighlights?.(() => clearAll())
  if (api.onShowPointer) api.onShowPointer(({ x, y, text }) => showPointer(x, y, text))
  if (api.onShowLocate) api.onShowLocate((items) => showLocate(items))
}

export {}
