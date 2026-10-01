// AgentTask state (CONTRACTS C6): pure helpers the runner uses to move steps along.
import type { AgentStepStatus, AgentTask } from '@shared/events'

const MAX_DETAIL = 12

export function newTask(id: string, prompt: string, now: number): AgentTask {
  return {
    id,
    prompt,
    summary: prompt,
    plan: [],
    steps: [],
    phase: 'planning',
    counters: { actions: 0, modelCalls: 0, costUsd: 0, startedAt: now }
  }
}

export function withPlan(task: AgentTask, summary: string, plan: string[]): AgentTask {
  return {
    ...task,
    summary,
    plan,
    steps: plan.map((label, i) => ({ i: i + 1, label, status: 'pending' }))
  }
}

/** The step a call without an explicit step number belongs to: the running one, else the next. */
export function currentStep(task: AgentTask): number | undefined {
  const running = task.steps.find((s) => s.status === 'running')
  if (running) return running.i
  return task.steps.find((s) => s.status === 'pending')?.i
}

/**
 * Marks step `n` running (earlier running/pending steps done) and appends `detail`.
 * Unknown step numbers only add nothing.
 */
export function enterStep(task: AgentTask, n: number | undefined, detail?: string): AgentTask {
  if (n === undefined || !task.steps.some((s) => s.i === n)) return task
  return {
    ...task,
    steps: task.steps.map((s) => {
      if (s.i < n && (s.status === 'running' || s.status === 'pending'))
        return { ...s, status: 'done' as const }
      if (s.i !== n) return s
      const status: AgentStepStatus =
        s.status === 'failed' ? 'running' : s.status === 'done' ? 'done' : 'running'
      const list = detail ? [...(s.detail ?? []), detail].slice(-MAX_DETAIL) : s.detail
      return { ...s, status, ...(list ? { detail: list } : {}) }
    })
  }
}

export function setStep(task: AgentTask, n: number, status: AgentStepStatus): AgentTask {
  return { ...task, steps: task.steps.map((s) => (s.i === n ? { ...s, status } : s)) }
}

/** Closes the step list when the task ends. */
export function closeSteps(task: AgentTask, ok: boolean): AgentTask {
  return {
    ...task,
    steps: task.steps.map((s) => {
      if (s.status === 'running') return { ...s, status: ok ? 'done' : 'failed' }
      if (s.status === 'pending') return { ...s, status: ok ? 'done' : 'skipped' }
      return s
    })
  }
}
