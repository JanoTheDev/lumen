export type LogTag = 'plan' | 'step' | 'verify' | 'retry' | 'fail' | 'skip' | 'done' | 'time'

const TAG_PAD = 9  // [verify] = 8 chars + 1 space; all tags fit within 9

export interface LogMeta {
  model?: string
  cost?: number
  timeMs?: number
}

function clockStamp(): string {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

export function log(tag: LogTag, message: string, meta: LogMeta = {}): void {
  const parts: string[] = [clockStamp(), `[${tag}]`.padEnd(TAG_PAD), message]
  if (meta.model) parts.push(`| ${meta.model}`)
  if (meta.cost != null) parts.push(`| $${meta.cost.toFixed(5)}`)
  if (meta.timeMs != null) parts.push(`| ${(meta.timeMs / 1000).toFixed(2)}s`)
  console.log(parts.join(' '))
}

export interface Timer {
  split(label: string): number
  total(): number
}

export function startTimer(label: string): Timer {
  const t0 = Date.now()
  let last = t0
  log('time', `START ${label}`)
  return {
    split(splitLabel: string): number {
      const now = Date.now()
      const dt = now - last
      last = now
      log('time', `  ${splitLabel}`, { timeMs: dt })
      return dt
    },
    total(): number {
      const total = Date.now() - t0
      log('time', `END ${label}`, { timeMs: total })
      return total
    }
  }
}
