// A skill's permission envelope (CONTRACTS C10): everything one run of a skill may use, built
// once and carried wherever the run goes on: the foreground model run, "resume the task", a
// background run, the foreground task its request_foreground starts and the helpers it spawns.
// The guard checks each call (profile, connectors, the skill's tool list, input apps, network,
// confirm-every-action for risky and untrusted skills); the lists keep the model from being
// offered what the guard would refuse anyway.
import type { LoadedSkill } from '../skills/registry'
import { checkSkillCall, classifyToolCall, mcpServerOf } from '../skills/permissions'
import { skillGuard, type GuardHost, type ToolGuard } from './skill-run'
import { FOREGROUND_TOOLS, type ToolName } from './tools'

export interface SkillEnvelope {
  /** The skill(s) it stands for, for logs. */
  skill: string
  guard: ToolGuard
  /** Foreground agent tools the skill may use (finish always). */
  tools: readonly ToolName[]
  /** MCP servers whose tools are offered. */
  connectors: readonly string[]
  /** URL patterns fetch_url may reach (every redirect hop too). */
  network: readonly string[]
  /** Folders read_file may read besides the user's background folders. */
  readRoots: readonly string[]
  /** Whether to offer a tool to the model at all (the guard still checks every call). */
  offers(tool: string): boolean
}

/** Tools whose verdict depends on the call (app, URL), not on the name alone. */
const PER_CALL = new Set(['input', 'launch', 'navigate'])

export function skillEnvelope(s: LoadedSkill, taskId: string, host: GuardHost): SkillEnvelope {
  const m = s.manifest
  const list = m.tools
  return {
    skill: m.name,
    guard: skillGuard(s, { taskId }, host),
    tools: list
      ? FOREGROUND_TOOLS.filter((t) => t === 'finish' || list.includes(t))
      : FOREGROUND_TOOLS,
    connectors: m.permissions.connectors,
    network: m.permissions.network,
    readRoots: m.permissions.files.read,
    offers: (tool) => {
      const call = classifyToolCall(tool, {}, null)
      // Trust only changes whether a call confirms, never whether it is allowed.
      return PER_CALL.has(call.kind) || checkSkillCall(m, s.baseTrust, call).ok
    }
  }
}

/** Every guard must allow the call; the first refusal wins. */
export function allGuards(guards: readonly ToolGuard[]): ToolGuard {
  return async (tool, input, signal) => {
    for (const g of guards) {
      const refused = await g(tool, input, signal)
      if (refused) return refused
    }
    return null
  }
}

/**
 * Several envelopes at once (a helper task with its own skill inside a skill run): the call
 * must pass every one of them, and only tools and connectors all of them allow are offered.
 */
export function joinEnvelopes(list: readonly SkillEnvelope[]): SkillEnvelope | undefined {
  if (list.length <= 1) return list[0]
  const [first, ...rest] = list
  return {
    skill: list.map((e) => e.skill).join(' + '),
    guard: allGuards(list.map((e) => e.guard)),
    tools: first.tools.filter((t) => rest.every((e) => e.tools.includes(t))),
    connectors: first.connectors.filter((c) => rest.every((e) => e.connectors.includes(c))),
    // Network and read folders are checked per envelope by the background run; these are only
    // the first one's for display.
    network: first.network,
    readRoots: first.readRoots,
    offers: (tool) => list.every((e) => e.offers(tool))
  }
}

/** Connector tool definitions limited to the envelope's servers. */
export function connectorDefsFor<T extends { name: string }>(
  defs: readonly T[],
  envelope: Pick<SkillEnvelope, 'connectors'> | undefined
): T[] {
  if (!envelope) return [...defs]
  return defs.filter((d) => envelope.connectors.includes(mcpServerOf(d.name) ?? ''))
}
