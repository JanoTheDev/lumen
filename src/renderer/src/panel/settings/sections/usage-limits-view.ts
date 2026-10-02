// Settings → Usage limits (05 T45): pure text for the limit rows.
import type { UsageLimitRow } from '@shared/usage'
import { money, tokens } from './usage-view'

export const hasCap = (r: Pick<UsageLimitRow, 'capUsd' | 'capTokens'>): boolean =>
  r.capUsd !== undefined || r.capTokens !== undefined

/** "$4.20 of $10.00 · 120k of 500k tokens" (or the spend alone without a cap). */
export function limitProgressText(r: UsageLimitRow): string {
  const parts: string[] = []
  if (r.capUsd !== undefined) parts.push(`${money(r.usd)} of ${money(r.capUsd)}`)
  if (r.capTokens !== undefined) parts.push(`${tokens(r.tokens)} of ${tokens(r.capTokens)} tokens`)
  if (!parts.length) return `${money(r.usd)} · ${tokens(r.tokens)} tokens, no limit`
  const tail = r.level === 'paused' ? ' · paused' : r.level === 'warn' ? ' · nearly there' : ''
  return parts.join(' · ') + tail
}

/** Thousands of tokens in the field; 0 = no cap. */
export const tokensToField = (n: number | undefined): number => Math.round((n ?? 0) / 1000)
export const fieldToTokens = (k: number): number => Math.round(k) * 1000
