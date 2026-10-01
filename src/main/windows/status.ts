// Status lines (listening / thinking / step n of m / errors), shown in the assistant bar.
import { loadConfig } from '../config'
import * as assistant from './assistant'
import { statusHoldMs } from '../a11y/timings'

export type StatusKind =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'acting'
  | 'answer'
  | 'error'
  | 'step'

export function setStatus(
  kind: StatusKind,
  text: string,
  step?: { index: number; total: number },
  requestedHideMs?: number
): void {
  // Timed lines stay at least a11y.timings.statusHoldMs (WCAG 2.2.1).
  assistant.status(kind, text, step, statusHoldMs(loadConfig(), requestedHideMs))
}

export function hideStatus(): void {
  assistant.settle()
}
