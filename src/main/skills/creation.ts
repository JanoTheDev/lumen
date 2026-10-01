// Making skills by voice (11 T09-T11, F9), the wiring: "save that as a skill" after a finished
// agent run, "when I say X, do Y", and "watch me make a skill" (07's step recorder in its skill
// output mode). Each makes a draft that waits for the user's review by voice: "save it",
// "call it …", "trigger it with …", "read it back", "discard it". A saved draft is the user's
// own skill in ~/.ai-overlay/skills. The model only writes the words (authoring.ts).
import type { ModelResponse } from '@shared/types'
import { announce } from '../a11y'
import { LOCAL_HANDLED } from '../a11y/dispatch'
import { getProvider } from '../ai/providers'
import { log } from '../logger'
import { describeStep, type RecordedApp, type SkeletonStep } from '../teach/recorder'
import {
  AUTHORING_PROMPT,
  authoringSchema,
  authoringTurn,
  describeTrace,
  draftFiles,
  draftFromText,
  draftFromVoice,
  freeName,
  matchCreateIntent,
  matchDraftCommand,
  readBack,
  skeletonToSteps,
  slugName,
  traceNetwork,
  traceToSteps,
  type AgentRunTrace,
  type AuthoringText,
  type SkillDraft
} from './authoring'
import { getSkillRegistry } from './index'
import { writeNewSkill } from './manage'

/** A draft waits this long for "save it" / "call it …". */
export const DRAFT_REVIEW_MS = 10 * 60_000
/** A bare "yes" only counts this soon after the draft was offered. */
export const YES_MS = 2 * 60_000
/** "save that as a skill" looks back this far. */
export const LAST_RUN_MS = 30 * 60_000
const WORDS_TIMEOUT_MS = 25_000

export interface RecordedSkillInput {
  app: RecordedApp
  title?: string
  steps: SkeletonStep[]
}

export interface CreationDeps {
  now(): number
  /** The model's words for a draft; null when it fails (plain words are used then). */
  words(turn: string): Promise<AuthoringText | null>
  /** Starts 07's recorder in its skill mode. */
  startRecording(title?: string): { ok: boolean; error?: string }
  save(draft: SkillDraft): { ok: true; name: string } | { ok: false; error: string }
  taken(name: string): boolean
  say(text: string): void
  log(msg: string): void
  /** What an intercept returns when it spoke for itself (the recorder's own lines). */
  handled: unknown
}

/** A response, a promise of one, or `handled`. */
type Reply = unknown

const answer = (text: string): ModelResponse => ({ mode: 'answer', text, spoken: text })

const sayable = (name: string): string => name.replace(/-/g, ' ')

export interface SkillCreation {
  /** A finished agent run that "save that as a skill" can use. */
  rememberRun(run: AgentRunTrace): void
  intercept(utterance: string): Reply | undefined
  /** The recorder stopped in skill mode. */
  fromRecording(input: RecordedSkillInput): Promise<void>
  draft(): SkillDraft | null
}

export function createSkillCreation(deps: CreationDeps): SkillCreation {
  let lastRun: AgentRunTrace | null = null
  let pending: { draft: SkillDraft; at: number } | null = null

  function offer(draft: SkillDraft): string {
    draft.name = freeName(draft.name, deps.taken)
    pending = { draft, at: deps.now() }
    deps.log(
      `skill draft "${draft.name}" (${draft.source}${draft.steps ? `, ${draft.steps.steps.length} steps` : ''})`
    )
    return `Draft skill “${sayable(draft.name)}”: ${draft.description} Say “save it”, “call it” and a name, “read it back”, or “discard it”.`
  }

  async function fromLastRun(name?: string): Promise<ModelResponse> {
    const run = lastRun
    if (!run || deps.now() - run.at > LAST_RUN_MS)
      return answer('There is no finished task to save yet. Ask me to do something first.')
    const text = await deps
      .words(authoringTurn(run.prompt, describeTrace(run)))
      .catch((e: Error) => {
        deps.log(`skill words failed (${e.message}); plain words used`)
        return null
      })
    const draft = draftFromText(text, {
      fallbackName: name ?? run.prompt,
      fallbackDescription: run.summary || run.prompt,
      fallbackInstructions: `Do this: ${run.prompt}\n\nWhat worked last time:\n${describeTrace(run)}`,
      triggers: name ? [name] : [],
      permissions: {
        input: run.steps.some((s) => s.tool !== 'wait_for'),
        network: traceNetwork(run)
      },
      steps: traceToSteps(run),
      source: 'agent-run'
    })
    if (name && slugName(name)) draft.name = slugName(name)
    return answer(offer(draft))
  }

  function save(name?: string): ModelResponse {
    const p = pending!
    if (name) {
      const slug = slugName(name)
      if (!slug) return answer('That name has no letters I can use. Try another.')
      p.draft.name = freeName(slug, deps.taken)
    }
    const r = deps.save(p.draft)
    if (!r.ok) return answer(`I could not save the skill: ${r.error}.`)
    pending = null
    const trigger = p.draft.triggers[0]
    return answer(
      `Saved the skill “${sayable(r.name)}”.${trigger ? ` Say “${trigger}” to run it.` : ''} You can change it in Settings, Skills.`
    )
  }

  function review(utterance: string): Reply | undefined {
    const p = pending
    if (!p) return undefined
    const age = deps.now() - p.at
    if (age > DRAFT_REVIEW_MS) {
      pending = null
      return undefined
    }
    const c = matchDraftCommand(utterance)
    if (!c) return undefined
    switch (c.cmd) {
      case 'yes':
        return age <= YES_MS ? save() : undefined
      case 'save':
        return save(c.name)
      case 'rename': {
        const slug = slugName(c.name)
        if (!slug) return answer('That name has no letters I can use. Try another.')
        p.draft.name = freeName(slug, deps.taken)
        p.at = deps.now()
        return answer(`Renamed it to “${sayable(p.draft.name)}”. Say “save it” to keep it.`)
      }
      case 'trigger': {
        const phrase = c.phrase.slice(0, 80)
        p.draft.triggers = [phrase, ...p.draft.triggers.filter((t) => t !== phrase)].slice(0, 5)
        p.at = deps.now()
        return answer(`It starts when you say “${phrase}”. Say “save it” to keep it.`)
      }
      case 'read':
        p.at = deps.now()
        return answer(readBack(p.draft))
      case 'discard':
        pending = null
        return answer('Draft skill discarded.')
    }
  }

  return {
    rememberRun(run) {
      if (run.steps.length) lastRun = run
    },

    draft: () => pending?.draft ?? null,

    intercept(utterance) {
      const reviewed = review(utterance)
      if (reviewed !== undefined) return reviewed
      const intent = matchCreateIntent(utterance)
      if (!intent) return undefined
      if (intent.kind === 'when') return answer(offer(draftFromVoice(intent.phrase, intent.action)))
      if (intent.kind === 'save-last') return fromLastRun(intent.name)
      const r = deps.startRecording(intent.title)
      return r.ok ? deps.handled : answer(`I can't record now: ${r.error}.`)
    },

    async fromRecording(input) {
      const { steps, params } = skeletonToSteps(input.steps)
      if (!steps.length) {
        deps.say('I did not see any steps I can repeat, so there is no skill to save.')
        return
      }
      const lines = input.steps.map(describeStep).join('\n')
      const text = await deps
        .words(
          authoringTurn(
            input.title ?? `something in ${input.app.name}`,
            `App: ${input.app.name}\n${lines}`,
            params.map((p) => p.name)
          )
        )
        .catch((e: Error) => {
          deps.log(`skill words failed (${e.message}); plain words used`)
          return null
        })
      const title = input.title ?? `steps in ${input.app.name}`
      const draft = draftFromText(text, {
        fallbackName: title,
        fallbackDescription: `Repeats your recorded steps in ${input.app.name}.`,
        fallbackInstructions: `Recorded in ${input.app.name}:\n${lines}`,
        ...(input.title ? { triggers: [input.title] } : {}),
        params,
        permissions: { input: true, network: [] },
        steps,
        source: 'recording'
      })
      deps.say(offer(draft))
    }
  }
}

// ---- the app's instance ----

let instance: SkillCreation | null = null

/** Skill making with the app's model, recorder and skills folder. */
export function installSkillCreation(
  startRecording: CreationDeps['startRecording']
): SkillCreation {
  instance = createSkillCreation({
    now: () => Date.now(),
    words: async (turn) => {
      const { llm, model, effort } = getProvider('fast')
      const res = await llm.complete(
        {
          model,
          system: [{ text: AUTHORING_PROMPT, cacheable: true }],
          messages: [{ role: 'user', content: turn }],
          maxTokens: 1500,
          effort,
          schema: authoringSchema,
          schemaName: 'lumen_skill_draft'
        },
        AbortSignal.timeout(WORDS_TIMEOUT_MS)
      )
      log('plan', `skill draft words written (${res.model})`)
      return res.data ?? null
    },
    startRecording,
    save: (draft) => {
      const registry = getSkillRegistry()
      if (!registry) return { ok: false, error: 'skills are not ready yet' }
      let files: ReturnType<typeof draftFiles>
      try {
        files = draftFiles(draft)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      const r = writeNewSkill(registry, draft.name, files)
      if (r.ok) log('done', `skill ${draft.name} saved from a ${draft.source} draft`)
      return r
    },
    taken: (name) => !!getSkillRegistry()?.get(name),
    say: (text) => announce(text, { kind: 'answer' }),
    log: (msg) => log('plan', msg),
    handled: LOCAL_HANDLED
  })
  return instance
}

/** Agent mode hands over each finished run (session.ts). */
export function rememberAgentRun(run: AgentRunTrace): void {
  instance?.rememberRun(run)
}

/** Voice: skill making and draft review; undefined = not ours. */
export function interceptSkillCreation(utterance: string): Reply | undefined {
  return instance?.intercept(utterance)
}

export function recordedSkill(input: RecordedSkillInput): Promise<void> {
  return instance ? instance.fromRecording(input) : Promise.resolve()
}
