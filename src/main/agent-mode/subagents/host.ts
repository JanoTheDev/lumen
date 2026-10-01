// Sub-agent wiring (08 T49): the app's one pool (Settings → agent.subagents.max) and the model
// turn for a role. The jobs themselves run in run.ts.
import type { Role } from '../../ai/models'
import { getProvider } from '../../ai/providers'
import { loadConfig } from '../../config'
import { SubagentPool } from './pool'
import type { SubagentEnv } from './run'

const TURN_MAX_TOKENS = 1500

let pool: SubagentPool | null = null

export type SubagentSettings = ReturnType<typeof loadConfig>['agent']['subagents']

const DEFAULTS: SubagentSettings = { max: 4, model: 'fast', costCapUsd: 0.05 }

/** Settings → agent.subagents (defaults when a config has none). */
export function subagentSettings(): SubagentSettings {
  return loadConfig().agent?.subagents ?? DEFAULTS
}

export function subagentPool(): SubagentPool {
  return (pool ??= new SubagentPool(() => subagentSettings().max))
}

/** One tool turn on `role`'s model. */
export function subagentTurn(role: Role): SubagentEnv['turn'] {
  return (req, signal) => {
    const { llm, model, effort } = getProvider(role)
    if (!llm.toolTurn) throw new Error('Helpers need a model with tool use (this one has none).')
    return llm.toolTurn({ ...req, model, effort, maxTokens: TURN_MAX_TOKENS }, signal)
  }
}
