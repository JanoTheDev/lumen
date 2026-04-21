export type LogTag = 'plan' | 'step' | 'verify' | 'retry' | 'fail' | 'skip' | 'done'

interface LogMeta {
  model?: string
  cost?: number
  timeMs?: number
}

export function log(tag: LogTag, message: string, meta: LogMeta = {}): void {
  const parts: string[] = [`[${tag}]`.padEnd(9), message]
  if (meta.model) parts.push(`| ${meta.model}`)
  if (meta.cost != null) parts.push(`| $${meta.cost.toFixed(5)}`)
  if (meta.timeMs != null) parts.push(`| ${(meta.timeMs / 1000).toFixed(1)}s`)
  console.log(parts.join(' '))
}
