// A buddy's spend this month, as the monthly limits count it (05 T45): an unpriced paid call
// counts at the task caps' fallback rate there, so the buddy's budget check, its detail page
// and the limit notices show the same numbers.
import { limitState } from '../usage/limits'
import type { BuddySpendReader } from './service'

/** This month's Lumen spend of the buddy (tokens = in + out), from the monthly limits. */
export const ledgerSpend: BuddySpendReader = (buddyId) => {
  const s = limitState({ kind: 'buddy', id: buddyId })
  return { usd: s.usd, tokens: s.tokens }
}
