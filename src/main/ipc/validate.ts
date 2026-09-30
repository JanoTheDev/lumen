import type { ZodType, infer as zInfer } from 'zod'
import { parsePayload } from '@shared/ipc'
import { log } from '../logger'

export const INVALID = { error: 'E_INVALID' } as const

// Validates a renderer payload; logs and returns undefined when it does not match.
export function safeParse<T extends ZodType>(
  channel: string,
  schema: T,
  value: unknown
): zInfer<T> | undefined {
  try {
    return parsePayload(channel, schema, value)
  } catch (e) {
    log('fail', (e as Error).message)
    return undefined
  }
}
