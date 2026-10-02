// Buddies (08 T50) inside background runs: a task with a buddyId runs under the buddy's
// envelope, model, per-run cost cap, notebook and usage scope. The buddies module sets the hook
// at start; without it a buddy task fails with a reason. No imports of buddies/ here (no cycle).
import type { BackgroundTask } from '@shared/types'
import type { Role } from '../../ai/models'
import type { SkillEnvelope } from '../skill-envelope'
import type { GuardHost } from '../skill-run'
import type { RunSkillInfo } from './run'

export interface BuddyTaskEnv {
  /** The buddy's permissions as a skill envelope (guard, tools, connectors, network, folders). */
  envelope: SkillEnvelope
  /** The envelope's stand-in skill (file-change confirms go by its trust). */
  info: RunSkillInfo
  role: Role
  /** The run's cost cap (the buddy's budget per run). */
  maxCostUsd: number
  /** run_subagents is offered. */
  subagents: boolean
  /** use_skill may load this skill. */
  allowSkill(name: string): boolean
  /** memory_write: the buddy's notebook. */
  memoryWrite(fact: string): 'ok' | 'rejected' | 'disabled'
  /** The notebook and who the buddy is, for the first turn ('' = nothing). */
  context: string
  /** Report style silent: no spoken notice when it ends (the result waits in the Tasks list). */
  silent: boolean
}

export interface BuddyRunHook {
  /** The run settings of a buddy's task, or why it cannot run (gone, off). */
  forTask(task: BackgroundTask, host: GuardHost): BuddyTaskEnv | string
  /** Runs the task inside the buddy's usage scope. */
  scope<T>(task: BackgroundTask, fn: () => Promise<T>): Promise<T>
  /** The buddy's report style is silent. */
  silent(task: BackgroundTask): boolean
}

let hook: BuddyRunHook | null = null

export function setBuddyRunHook(h: BuddyRunHook | null): void {
  hook = h
}

export function buddyRunHook(): BuddyRunHook | null {
  return hook
}
