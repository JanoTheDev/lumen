// The `memory_search` tool for tool-using runs (agent mode, research): looks up past sessions
// (episode summaries, links, files, open threads) and saved facts that match a query, for
// requests like "open that tutorial link from last week". Read-only; empty when memory is off.
import { z } from 'zod'
import type { ToolDef } from '../providers/types'
import type { Memory } from '.'
import type { Fact } from './store'
import { tokenize } from './retrieve'

export const memorySearchInput = z.object({
  query: z.string().describe('What to look for, in a few words ("blender export tutorial link").'),
  app: z.string().optional().describe('Only sessions that used this app, e.g. "Blender".')
})

export const MEMORY_SEARCH_TOOL: ToolDef = {
  name: 'memory_search',
  description:
    'Search what Lumen remembers about this user: summaries of past sessions (with links, files, lessons and unfinished work) and saved facts. Use it when the task refers to something from before ("the link from last week", "the file we fixed yesterday"). Returns at most 5 sessions.',
  schema: memorySearchInput
}

const MAX_EPISODES = 5
const MAX_FACTS = 8

function matchingFacts(facts: Fact[], terms: Set<string>): Fact[] {
  return facts.filter((f) => tokenize(f.text).some((t) => terms.has(t)))
}

/** The tool result: matching facts, then matching sessions (best first), as plain lines. */
export function memorySearch(mem: Memory, input: z.infer<typeof memorySearchInput>): string {
  if (!mem.isEnabled()) return 'Memory is off; nothing is saved about past sessions.'
  const terms = new Set(tokenize(`${input.query} ${input.app ?? ''}`))
  const facts = [
    ...matchingFacts(mem.profile.facts(), terms),
    ...(input.app ? mem.apps.facts(input.app) : []),
    ...matchingFacts(mem.working.facts(), terms)
  ].slice(0, MAX_FACTS)
  const episodes = mem.searchEpisodes(input.query, input.app, MAX_EPISODES)
  if (!facts.length && !episodes.length) return `Nothing saved matches "${input.query}".`
  const lines: string[] = []
  if (facts.length) lines.push('Saved facts:', ...facts.map((f) => `- ${f.text}`))
  if (episodes.length) {
    lines.push('Past sessions (best match first):')
    for (const { episode: e } of episodes) {
      const apps = e.apps.length ? ` · ${e.apps.join(', ')}` : ''
      lines.push(`- ${e.date.slice(0, 10)}${apps} · ${e.title} (${e.outcome}): ${e.summary}`)
      if (e.openThreads.length) lines.push(`  open: ${e.openThreads.join('; ')}`)
      for (const r of e.refs) lines.push(`  ${r.kind}: ${r.value}`)
    }
  }
  return lines.join('\n')
}
