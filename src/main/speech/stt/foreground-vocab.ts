// Glossary terms of the app in front when a recording starts (skill packs), for the cloud
// transcription prompt. Read once per recording through the agent's focus_info; a pack's
// glossary is parsed once.
import { readFileSync } from 'fs'
import { join } from 'path'
import { matchSkill } from '../../ai/skills'
import { getAgent } from '../../agent/instance'
import { bus } from '../../bus'
import { glossaryTerms } from './vocabulary'

const FOCUS_TIMEOUT_MS = 800
const cache = new Map<string, string[]>()
let current: string[] = []

function packTerms(id: string, dir: string): string[] {
  let terms = cache.get(id)
  if (!terms) {
    try {
      terms = glossaryTerms(readFileSync(join(dir, 'glossary.md'), 'utf8'))
    } catch {
      terms = []
    }
    cache.set(id, terms)
  }
  return terms
}

async function refresh(): Promise<void> {
  current = []
  const agent = getAgent()
  if (!agent) return
  try {
    const f = await agent.request<Record<string, unknown>>(
      'focus_info',
      {},
      { timeoutMs: FOCUS_TIMEOUT_MS }
    )
    const pack = matchSkill({ process: String(f?.process ?? ''), title: String(f?.title ?? '') })
    current = pack ? packTerms(pack.id, pack.dir) : []
  } catch {
    current = []
  }
}

/** Terms of the app that was in front when the current recording started. */
export function foregroundTerms(): readonly string[] {
  return current
}

bus.on('voice.started', () => void refresh())
bus.on('dictation.started', () => void refresh())
