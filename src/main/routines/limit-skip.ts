// Monthly usage limits (05 T45) for automation runs: a capped automation or buddy is skipped, so
// refusals never count as failures (three failures in a row would turn the automation off).
import type { Automation } from '@shared/automations'
import { canStartRun } from '../usage/limits'
import type { RunEnd } from './engine'

export function limitSkip(a: Automation, check = canStartRun): RunEnd | null {
  const act = a.action
  if (act.kind === 'remind') return null
  const limit = check({
    automationId: a.id,
    ...(act.kind === 'buddy' ? { buddyId: act.buddyId } : {})
  })
  return limit.ok ? null : { result: 'skipped', summary: limit.reason }
}
