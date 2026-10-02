// Practice challenges wiring (11 T22): the real deps for ChallengeRunner (fast model, agent
// capture, the Blender bridge, 07 progress, the announcer). teach/index calls
// installChallenges() and asks interceptChallenge() in its voice hook.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { bus } from '../bus'
import { loadConfig } from '../config'
import { log } from '../logger'
import * as commands from '../agent/commands'
import { getAgent } from '../agent/instance'
import { announce } from '../a11y'
import { getProvider } from '../ai/providers'
import { readingLevelLineFor } from '../coach/reading-level'
import { bridgeState } from './bridges'
import {
  appMastery,
  CHALLENGE_SYSTEM,
  CHECK_SYSTEM,
  checkReplySchema,
  genChallengeSchema,
  migrateChallenges,
  weakSkills,
  type ChallengeData
} from './challenges'
import { ChallengeRunner, type ChallengeApp } from './challenge-run'
import { matchAppOnly } from './commands'
import { appIdFor } from './generate'
import type { ProgressStore } from './progress'
import type { SkillRegistry } from './registry'
import { withUsageScope } from '../usage/scope'

const FILE = join(homedir(), '.ai-overlay', 'teach', 'challenges.json')
const MODEL_TIMEOUT_MS = 25_000

let runner: ChallengeRunner | null = null

export function challengeRunner(): ChallengeRunner | null {
  return runner
}

function load(): ChallengeData {
  try {
    return migrateChallenges(existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null)
  } catch {
    return migrateChallenges(null)
  }
}

function save(data: ChallengeData): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(`${FILE}.tmp`, JSON.stringify(data, null, 2), 'utf8')
    renameSync(`${FILE}.tmp`, FILE)
  } catch (e) {
    log('fail', `challenges not saved (${(e as Error).message})`)
  }
}

export function installChallenges(deps: {
  registry(): SkillRegistry | null
  store(): ProgressStore | null
}): void {
  if (runner) return
  const appOf = (w: commands.ActiveWindowInfo): ChallengeApp | null => {
    const process = w.process || w.exe
    const skill = deps.registry()?.matchApp({ process, title: w.title })
    if (skill) return { id: skill.id, name: skill.name }
    if (!process || /\blumen\b/i.test(w.title)) return null
    return {
      id: appIdFor(null, process),
      name: process
        .split(/[\\/]/)
        .pop()!
        .replace(/\.exe$/i, '')
    }
  }
  runner = new ChallengeRunner(
    {
      now: () => Date.now(),
      foregroundApp: async () => {
        const agent = getAgent()
        const w = agent
          ? await commands.activeWindow(agent, { timeoutMs: 1500 }).catch(() => null)
          : null
        return w ? appOf(w) : null
      },
      appByName: (q) => {
        const all = deps.registry()?.all() ?? []
        const id = matchAppOnly(q, all)
        const s = id ? all.find((x) => x.id === id) : null
        return s ? { id: s.id, name: s.name } : null
      },
      learner: (appId) => {
        const p = deps.store()?.get()
        const skill = deps.registry()?.get(appId)
        const done = (skill?.lessons ?? [])
          .filter((l) => (p?.lessons[l.id]?.completedAt.length ?? 0) > 0)
          .map((l) => l.title)
        return {
          mastery: p ? appMastery(p.mastery, appId) : null,
          weak: p ? weakSkills(p.mastery, appId) : [],
          done
        }
      },
      readingLevel: (appId) => readingLevelLineFor(loadConfig().helpers, appId),
      generate: async (system, user) => {
        const { llm, model, effort } = getProvider('fast')
        const res = await withUsageScope({ origin: 'lesson', feature: 'challenge' }, () =>
          llm.complete(
            {
              model,
              system: [{ text: system, cacheable: true }],
              messages: [{ role: 'user', content: user }],
              maxTokens: 600,
              effort,
              schema: genChallengeSchema,
              schemaName: 'lumen_challenge'
            },
            AbortSignal.timeout(MODEL_TIMEOUT_MS)
          )
        )
        log('plan', `challenge made (${res.model})`)
        return res.data
      },
      capture: async () => {
        const agent = getAgent()
        if (!agent) return null
        const r = await commands
          .capture(
            agent,
            { monitor: 'foreground', maxWidth: 1280, quality: 75 },
            { timeoutMs: 4000 }
          )
          .catch(() => null)
        const f = r?.frames[0]
        return f ? { data: f.data, mime: f.mime } : null
      },
      appState: async (appId) => {
        const s = await bridgeState(appId, AbortSignal.timeout(3000))
        return s ? JSON.stringify(s) : null
      },
      judge: async (system, user, image) => {
        const { llm, model, effort } = getProvider('fast')
        const res = await withUsageScope({ origin: 'lesson', feature: 'challenge' }, () =>
          llm.complete(
            {
              model,
              system: [{ text: system, cacheable: true }],
              messages: [{ role: 'user', content: user }],
              images: [
                {
                  base64: image.data,
                  mediaType: image.mime === 'image/png' ? 'image/png' : 'image/jpeg'
                }
              ],
              maxTokens: 700,
              effort,
              schema: checkReplySchema,
              schemaName: 'lumen_challenge_check'
            },
            AbortSignal.timeout(MODEL_TIMEOUT_MS)
          )
        )
        log('verify', `challenge checked (${res.model})`)
        return res.data
      },
      practice: (appId, skills, quality) => deps.store()?.practice(appId, skills, quality),
      load,
      save,
      say: (text) => announce(text, { kind: 'answer' }),
      showLine: (text) =>
        bus.emit({
          type: 'lesson.state',
          state: text ? { phase: 'waiting-user', statusText: text } : null
        }),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return t
      },
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      log: (msg) => log('plan', msg),
      handled: null
    },
    { generate: CHALLENGE_SYSTEM, check: CHECK_SYSTEM }
  )
  runner.resume()
}

/** Voice: "give me a challenge", "check my work", "give up", "what's my streak". */
export function interceptChallenge(utterance: string): unknown | undefined {
  return runner?.intercept(utterance)
}
