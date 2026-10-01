// Skill health from the run history (11 F9): a skill whose recorded steps keep drifting, or
// that keeps failing, "needs an update". Lumen says so once (presence rules) and offers the
// "update it" path, which re-writes it from the latest run that worked. Pure.
import type { SkillRunRecord } from '@shared/types'

/** How many of the latest runs are looked at, and how many bad ones make a skill stale. */
export const HEALTH_WINDOW = 3
export const HEALTH_BAD = 2

/** A run that shows the skill is out of date: its steps drifted, or it failed. */
export function badRun(r: SkillRunRecord): boolean {
  return r.how === 'steps+agent' || r.status === 'failed'
}

/** Newest-first history → whether the skill needs an update. */
export function needsUpdate(runs: readonly SkillRunRecord[]): boolean {
  const recent = runs.filter((r) => r.status !== 'cancelled').slice(0, HEALTH_WINDOW)
  if (recent.length < HEALTH_BAD) return false
  // A clean run since the trouble: fine again.
  if (!badRun(recent[0])) return false
  return recent.filter(badRun).length >= HEALTH_BAD
}

export function needsUpdateLine(name: string): string {
  const say = name.replace(/-/g, ' ')
  return `The skill “${say}” did not go as recorded the last few times. Say “update the ${say} skill” and I'll rewrite it from the last run that worked.`
}
