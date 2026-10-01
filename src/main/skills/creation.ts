// Making skills by voice (11 T09-T11, F9), the wiring: "save that as a skill" after a finished
// agent run, "when I say X, do Y", and "watch me make a skill" (07's step recorder in its skill
// output mode). Each makes a draft that waits for the user's review by voice: "save it",
// "call it …", "trigger it with …", "read it back", "discard it". A saved draft is the user's
// own skill in ~/.ai-overlay/skills. The model only writes the words (authoring.ts).
// Claude-style additions (compose.ts, edit.ts, proposals.ts, health.ts): "make a skill that …"
// (the model writes the whole SKILL.md), voice edits ("change my morning skill to also open
// Slack") reviewed as a diff, the once-per-pattern offer to save a repeated or corrected task,
// "this skill needs an update" from its run history, and the agent's create_skill /
// update_skill tools (always the bar's confirm card).
import { homedir } from 'os'
import { join } from 'path'
import type { ModelResponse, SkillRunRecord } from '@shared/types'
import { announce } from '../a11y'
import { LOCAL_HANDLED } from '../a11y/dispatch'
import { bus } from '../bus'
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
import {
  authorSkill,
  draftFromCompose,
  permissionWords,
  validateDraftFiles,
  matchComposeIntent,
  type AuthorSkillResult,
  type ComposeOutput
} from './compose'
import {
  EDIT_PROMPT,
  checkEdit,
  editOfferLine,
  editSchema,
  editTurn,
  findSkill,
  matchEditIntent,
  type EditLimits,
  type EditOutput,
  type SkillRef
} from './edit'
import { setSkillAuthoringHost } from './agent-tools'
import { needsUpdate, needsUpdateLine } from './health'
import {
  connectorChoices,
  getSkillRegistry,
  matchTrigger,
  onSkillRun,
  proposalKey,
  proposalsMayRecord,
  skillGoodRuns,
  skillRuns
} from './index'
import { saveSkillFiles, writeNewSkill } from './manage'
import { SKILL_FILE } from './manifest'
import { GoodRunStore } from './runs'
import {
  OFFERS_ON_RE,
  ProposalStore,
  isCorrection,
  matchOfferAnswer,
  offerLine,
  requestWords,
  type ProposalReason,
  type RunSignature
} from './proposals'
import { readSkillText } from './registry'

/** A draft waits this long for "save it" / "call it …". */
export const DRAFT_REVIEW_MS = 10 * 60_000
/** A bare "yes" only counts this soon after the draft was offered. */
export const YES_MS = 2 * 60_000
/** "save that as a skill" looks back this far. */
export const LAST_RUN_MS = 30 * 60_000
const WORDS_TIMEOUT_MS = 25_000
/** An offer ("Want me to save this as a skill?") waits this long for yes / no. */
export const OFFER_MS = 3 * 60_000
/** "update it" after a needs-update notice works this long. */
export const UPDATE_MS = 10 * 60_000
/** A failed attempt this recent and alike makes the next success "corrected". */
const RETRY_MS = 10 * 60_000

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
  /** "make a skill that …": the model writes a whole skill (compose.ts). */
  compose?(description: string): Promise<AuthorSkillResult>
  /** The model's edit of a SKILL.md (edit.ts); null when it fails. */
  editWords?(turn: string): Promise<EditOutput | null>
  /** Skills by name and phrases, for "change my morning skill …". */
  skills?(): SkillRef[]
  /** The apps and connectors an edited skill may name (the clamp of new skills). */
  editLimits?(): Promise<EditLimits>
  /** A skill's SKILL.md and whether it has steps.json; null when unknown. */
  skillText?(name: string): { text: string; hasSteps: boolean } | null
  saveEdit?(
    name: string,
    files: { skillMd: string; stepsJson?: string | null }
  ): { ok: true } | { ok: false; error: string }
  /** The latest run that worked per skill (memory only when left out). */
  goodRuns?(): GoodRunStore | null
  /** The once-per-pattern offers and needs-update notices. */
  proposals?: ProposalStore
  /** The user is around and not in quiet mode (presence rule). */
  canSpeakUp?(): boolean
  /** A line under the presence rule (after the user's turn when one is going on). */
  notice?(text: string): void
  /** A skill already runs on this request (its trigger phrase matches). */
  covered?(prompt: string): boolean
  /** The bar's confirm card (agent tools). */
  confirm?(summary: string, risk: 'low' | 'medium' | 'high'): Promise<boolean>
  /** Runs later (default setTimeout); a skill run records its history right after its task. */
  later?(fn: () => void, ms: number): void
}

/** create_skill from the agent (the model writes the fields; Lumen checks and confirms). */
export interface AgentSkillProposal {
  name: string
  description: string
  triggers: string[]
  instructions: string
  needs_input: boolean
  websites: string[]
  why: string
}

type Pending =
  | { kind: 'draft'; draft: SkillDraft; at: number }
  | {
      kind: 'edit'
      name: string
      text: string
      /** string: new steps.json; null: remove it; undefined: keep. */
      stepsJson?: string | null
      line: string
      details: string[]
      /** The edit asks for more than before. */
      widens: boolean
      at: number
    }

/** A response, a promise of one, or `handled`. */
type Reply = unknown

const answer = (text: string): ModelResponse => ({ mode: 'answer', text, spoken: text })

const sayable = (name: string): string => name.replace(/-/g, ' ')

/** " Starts when you say “a” or “b”." for the confirm card. */
const startsWhen = (triggers: readonly string[]): string =>
  triggers.length ? ` Starts when you say ${triggers.map((t) => `“${t}”`).join(' or ')}.` : ''

/** Lumen's own short commands a skill phrase may never take over. */
const RESERVED_PHRASE_RE =
  /^(?:cancel|stop|abort|never ?mind|forget it|yes|no|ok|okay|do it|go ahead|undo(?: that| it)?|help|next|back|repeat|done|save it|discard it|read it back|what can you do)$/

export interface SkillCreation {
  /** A finished agent run that "save that as a skill" can use. */
  rememberRun(run: AgentRunTrace): void
  intercept(utterance: string): Reply | undefined
  /** The recorder stopped in skill mode. */
  fromRecording(input: RecordedSkillInput): Promise<void>
  draft(): SkillDraft | null
  /** The foreground agent task changed (bus agent.task): corrections and failed attempts. */
  noteTask(task: { prompt: string; phase: string } | null): void
  /** A skill run ended (its history entry): the run behind it, and its health. */
  skillRan(name: string, run: SkillRunRecord, history: readonly SkillRunRecord[]): void
  /** "make a skill that …" from Settings or another caller: the draft for review. */
  compose(description: string): Promise<ModelResponse>
  /** Agent tool create_skill: checked, confirmed on the bar, saved. Text for the model. */
  proposeFromAgent(input: AgentSkillProposal): Promise<{ ok: boolean; text: string }>
  /** Agent tool update_skill. */
  editFromAgent(name: string, change: string): Promise<{ ok: boolean; text: string }>
}

export function createSkillCreation(deps: CreationDeps): SkillCreation {
  let lastRun: AgentRunTrace | null = null
  let pending: Pending | null = null
  /** The offer to save the last run as a skill, waiting for yes / no. */
  let offered: { sig: RunSignature; run: AgentRunTrace; at: number } | null = null
  /** A needs-update notice, for "update it". */
  let stale: { name: string; at: number } | null = null
  /** The latest run that worked, per skill, for "update the X skill" (kept across restarts). */
  const memoryRuns = new GoodRunStore(null)
  const goodRuns = (): GoodRunStore => deps.goodRuns?.() ?? memoryRuns
  let task: { prompt: string; phase: string; corrected: boolean } | null = null
  let failed: { words: string[]; at: number }[] = []
  let corrected = false
  const later = (fn: () => void, ms: number): void =>
    deps.later ? deps.later(fn, ms) : void setTimeout(fn, ms)

  function offer(draft: SkillDraft): string {
    draft.name = freeName(draft.name, deps.taken)
    pending = { kind: 'draft', draft, at: deps.now() }
    deps.log(
      `skill draft "${draft.name}" (${draft.source}${draft.steps ? `, ${draft.steps.steps.length} steps` : ''})`
    )
    const may = draft.source === 'model' ? ` ${permissionWords(draft.permissions, draft.apps)}` : ''
    return `Draft skill “${sayable(draft.name)}”: ${draft.description}${may} Say “save it”, “call it” and a name, “read it back”, or “discard it”.`
  }

  /** `run`: the offered one ("yes" saves what was offered, not a later run). */
  async function fromLastRun(name?: string, run = lastRun): Promise<ModelResponse> {
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
    if (p.kind === 'edit') return saveEdit(p)
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

  function saveEdit(p: Extract<Pending, { kind: 'edit' }>): ModelResponse {
    return answer(applyEdit(p).text)
  }

  function applyEdit(p: Extract<Pending, { kind: 'edit' }>): { ok: boolean; text: string } {
    const r = deps.saveEdit
      ? deps.saveEdit(p.name, {
          skillMd: p.text,
          ...(p.stepsJson !== undefined ? { stepsJson: p.stepsJson } : {})
        })
      : { ok: false as const, error: 'skills are not ready yet' }
    if (!r.ok) return { ok: false, text: `I could not change the skill: ${r.error}.` }
    if (pending === p) pending = null
    deps.proposals?.clearNotice(p.name)
    if (stale?.name === p.name) stale = null
    deps.log(`skill ${p.name} changed`)
    return { ok: true, text: `Saved the change to “${sayable(p.name)}”.` }
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
    if (p.kind === 'edit') {
      switch (c.cmd) {
        case 'yes':
          return age <= YES_MS ? save() : undefined
        case 'save':
          return save()
        case 'read':
          p.at = deps.now()
          return answer([p.line.replace(/ Say “save it”.*$/, ''), ...p.details].join(' '))
        case 'discard':
          pending = null
          return answer('Change discarded. The skill stays as it was.')
        default:
          return answer('A changed skill keeps its name. Say “save it” or “discard it”.')
      }
    }
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
        return answer(
          p.draft.source === 'model'
            ? `${readBack(p.draft)} ${permissionWords(p.draft.permissions, p.draft.apps)}`
            : readBack(p.draft)
        )
      case 'discard':
        pending = null
        return answer('Draft skill discarded.')
    }
  }

  async function compose(description: string): Promise<ModelResponse> {
    if (!deps.compose) return answer('I cannot write skills right now.')
    const r = await deps.compose(description)
    if (!r.ok) return answer(`I could not write that skill: ${r.error}.`)
    if (r.warnings.length) deps.log(`skill draft notes: ${r.warnings.join('; ')}`)
    const line = offer(r.draft)
    const steps = r.draft.steps
      ? ` It has ${r.draft.steps.steps.length} fixed steps that run without the AI.`
      : ''
    return answer(line.replace(/ Say “save it”/, `${steps} Say “save it”`))
  }

  // ---- offers (proposals.ts) ----

  function considerOffer(run: AgentRunTrace, wasCorrected: boolean): void {
    const store = deps.proposals
    if (!store) return
    const verdict = store.consider(run, {
      corrected: wasCorrected,
      covered: !!deps.covered?.(run.prompt),
      now: deps.now()
    })
    if (!verdict || pending || (deps.canSpeakUp && !deps.canSpeakUp())) return
    offered = { sig: verdict.sig, run, at: deps.now() }
    store.answered(verdict.sig, 'offered', deps.now())
    deps.log(`offering to save a ${verdict.reason} task as a skill`)
    ;(deps.notice ?? deps.say)(offerLine(verdict.reason as ProposalReason))
  }

  function answerOffer(utterance: string): Reply | undefined {
    const o = offered
    if (!o) return undefined
    if (deps.now() - o.at > OFFER_MS) {
      offered = null
      return undefined
    }
    const a = matchOfferAnswer(utterance)
    if (!a) return undefined
    offered = null
    if (a === 'yes') {
      deps.proposals?.answered(o.sig, 'yes', deps.now())
      return fromLastRun(undefined, o.run)
    }
    deps.proposals?.answered(o.sig, 'no', deps.now())
    if (a === 'never') {
      deps.proposals?.setOff(true)
      return answer(
        'Okay, I will stop offering to save skills. Say “start offering skills again” to undo that.'
      )
    }
    return answer('Okay, I will not ask about this one again.')
  }

  /** A phrase an existing skill or one of Lumen's own commands already answers. */
  function phraseTaken(phrase: string): boolean {
    return (
      RESERVED_PHRASE_RE.test(phrase) ||
      !!deps.covered?.(phrase) ||
      !!matchDraftCommand(phrase) ||
      !!matchOfferAnswer(phrase) ||
      !!matchCreateIntent(phrase) ||
      !!matchEditIntent(phrase) ||
      !!matchComposeIntent(phrase)
    )
  }

  function similarToFailed(prompt: string): boolean {
    const now = deps.now()
    failed = failed.filter((f) => now - f.at <= RETRY_MS)
    const w = new Set(requestWords(prompt))
    if (!w.size) return false
    return failed.some((f) => {
      const inter = f.words.filter((x) => w.has(x)).length
      return inter / new Set([...f.words, ...w]).size >= 0.5
    })
  }

  // ---- edits (edit.ts) ----

  function resolveSkill(target: string): { name: string } | { reply: ModelResponse } {
    const found = findSkill(target, deps.skills?.() ?? [])
    if (!found) return { reply: answer(`I can't find a skill called “${target}”.`) }
    if ('ambiguous' in found)
      return {
        reply: answer(
          `Which skill do you mean: ${found.ambiguous.map((n) => `“${sayable(n)}”`).join(' or ')}?`
        )
      }
    return found
  }

  async function makeEdit(
    name: string,
    change: string,
    opts: { run?: AgentRunTrace; refresh?: boolean } = {}
  ): Promise<
    { ok: true; pending: Extract<Pending, { kind: 'edit' }> } | { ok: false; error: string }
  > {
    const cur = deps.skillText?.(name)
    if (!cur || !deps.editWords) return { ok: false, error: 'I cannot change that skill right now' }
    const out = await deps
      .editWords(editTurn(cur.text, change, opts.run ? describeTrace(opts.run) : undefined))
      .catch((e: Error) => {
        deps.log(`skill edit failed (${e.message})`)
        return null
      })
    if (!out) return { ok: false, error: 'the AI could not change it' }
    const checked = checkEdit(cur.text, out, {
      hasSteps: cur.hasSteps,
      ...(deps.editLimits ? { limits: await deps.editLimits() } : {})
    })
    if (!checked.ok) return { ok: false, error: checked.error }
    // An update from a run that worked: fresh steps from that run when it can repeat.
    let stepsJson: string | null | undefined = checked.dropSteps ? null : undefined
    let newSteps: number | undefined
    if (opts.refresh) {
      const steps = opts.run ? traceToSteps(opts.run) : null
      if (steps?.length) {
        stepsJson = `${JSON.stringify({ version: 1, steps }, null, 2)}\n`
        newSteps = steps.length
      } else if (cur.hasSteps) stepsJson = null
    }
    const line = editOfferLine(name, {
      summary: checked.summary,
      diff: checked.diff,
      dropSteps: stepsJson === null,
      ...(newSteps !== undefined ? { newSteps } : {})
    })
    return {
      ok: true,
      pending: {
        kind: 'edit',
        name,
        text: checked.text,
        ...(stepsJson !== undefined ? { stepsJson } : {}),
        line,
        details: checked.diff.lines,
        widens: checked.diff.widens,
        at: deps.now()
      }
    }
  }

  async function voiceEdit(target: string, change: string): Promise<ModelResponse> {
    const r = resolveSkill(target)
    if ('reply' in r) return r.reply
    const e = await makeEdit(r.name, change)
    if (!e.ok) return answer(`I could not change “${sayable(r.name)}”: ${e.error}.`)
    pending = e.pending
    return answer(e.pending.line)
  }

  const REFRESH_CHANGE =
    'Rewrite the instructions so they match how the task worked in the latest successful run below. Keep what still applies, describe controls by their names, no coordinates.'
  const HARDEN_CHANGE =
    'The recorded steps keep drifting. Make the instructions sturdier: describe each control by its visible name and what to check after each step, and ask the user when something is not where expected.'

  async function updateSkill(name: string): Promise<ModelResponse> {
    const run = goodRuns().get(name)
    const e = await makeEdit(name, run ? REFRESH_CHANGE : HARDEN_CHANGE, {
      ...(run ? { run } : {}),
      refresh: true
    })
    if (!e.ok) return answer(`I could not update “${sayable(name)}”: ${e.error}.`)
    pending = e.pending
    return answer(e.pending.line)
  }

  return {
    rememberRun(run) {
      if (!run.steps.length) return
      lastRun = run
      const wasCorrected = corrected || similarToFailed(run.prompt)
      corrected = false
      // A skill run records its history right after its task ends (skillRan marks run.skill).
      later(() => considerOffer(run, wasCorrected), 1500)
    },

    draft: () => (pending?.kind === 'draft' ? pending.draft : null),

    intercept(utterance) {
      const answered = answerOffer(utterance)
      if (answered !== undefined) return answered
      const reviewed = review(utterance)
      if (reviewed !== undefined) return reviewed
      const intent = matchCreateIntent(utterance)
      if (intent) {
        if (intent.kind === 'when')
          return answer(offer(draftFromVoice(intent.phrase, intent.action)))
        if (intent.kind === 'save-last') return fromLastRun(intent.name)
        const r = deps.startRecording(intent.title)
        return r.ok ? deps.handled : answer(`I can't record now: ${r.error}.`)
      }
      const make = matchComposeIntent(utterance)
      if (make && deps.compose) return compose(make.description)
      const edit = deps.editWords ? matchEditIntent(utterance) : null
      if (edit?.kind === 'edit') return voiceEdit(edit.target, edit.change)
      if (edit?.kind === 'update') {
        const r = resolveSkill(edit.target)
        return 'reply' in r ? r.reply : updateSkill(r.name)
      }
      if (edit?.kind === 'update-last' && stale && deps.now() - stale.at <= UPDATE_MS)
        return updateSkill(stale.name)
      if (
        deps.proposals &&
        OFFERS_ON_RE.test(
          utterance
            .toLowerCase()
            .replace(/[^a-z\s]/g, '')
            .trim()
        )
      ) {
        deps.proposals.setOff(false)
        return answer('Okay, I will offer to save tasks you repeat as skills again.')
      }
      // Words to a running task that correct it: the run is "corrected" (not ours to answer).
      if (task && isCorrection(utterance)) corrected = true
      return undefined
    },

    noteTask(t) {
      if (t) {
        if (task?.prompt !== t.prompt) corrected = false
        task = { prompt: t.prompt, phase: t.phase, corrected }
        return
      }
      if (task && (task.phase === 'failed' || task.phase === 'aborted'))
        failed = [...failed, { words: requestWords(task.prompt), at: deps.now() }].slice(-10)
      task = null
    },

    skillRan(name, rec, history) {
      const run = lastRun
      if (run && run.at >= rec.at - 1000 && run.at <= rec.at + rec.ms + 5000) {
        run.skill = name
        if (rec.status === 'done') goodRuns().set(name, run)
      }
      if (!needsUpdate(history) || !deps.proposals) return
      if (deps.canSpeakUp && !deps.canSpeakUp()) return
      if (!deps.proposals.noticeOnce(name)) return
      stale = { name, at: deps.now() }
      deps.log(`skill ${name} needs an update (drift or failures)`)
      ;(deps.notice ?? deps.say)(needsUpdateLine(name))
    },

    compose,

    async proposeFromAgent(input) {
      if (!deps.confirm) return { ok: false, text: 'Skills cannot be saved right now.' }
      const out: ComposeOutput = {
        name: input.name,
        description: input.description,
        when_to_use: '',
        triggers: input.triggers,
        instructions: input.instructions,
        params: [],
        apps: [],
        needs_input: input.needs_input,
        websites: input.websites,
        profile: false,
        connectors: [],
        tools: [],
        steps_json: '',
        references: []
      }
      const { draft } = draftFromCompose(out, { description: input.description }, deps.taken)
      // Phrases another skill or Lumen's own commands already answer are not taken over.
      const clashes = draft.triggers.filter(phraseTaken)
      draft.triggers = draft.triggers.filter((t) => !clashes.includes(t))
      const dropped = clashes.length
        ? ` Left out the phrases ${clashes.map((t) => `"${t}"`).join(', ')}: they already start something else.`
        : ''
      let files: ReturnType<typeof draftFiles>
      try {
        files = draftFiles(draft)
        validateDraftFiles(files)
      } catch (e) {
        return { ok: false, text: `The skill is not valid: ${(e as Error).message}` }
      }
      const why = input.why.replace(/\s+/g, ' ').trim().slice(0, 160)
      const yes = await deps.confirm(
        `Save a new skill “${sayable(draft.name)}”? ${draft.description}${why ? ` (${why})` : ''}${startsWhen(draft.triggers)} ${permissionWords(draft.permissions)}`,
        draft.permissions.input || draft.permissions.network.length ? 'medium' : 'low'
      )
      if (!yes)
        return { ok: true, text: 'The user said no. Do not propose this skill again in this task.' }
      const r = deps.save(draft)
      if (!r.ok) return { ok: false, text: `Not saved: ${r.error}` }
      return {
        ok: true,
        text: `Saved the skill "${r.name}".${draft.triggers[0] ? ` It runs when the user says "${draft.triggers[0]}".` : ''}${dropped}`
      }
    },

    async editFromAgent(name, change) {
      if (!deps.confirm) return { ok: false, text: 'Skills cannot be changed right now.' }
      if (!deps.skillText?.(name)) return { ok: false, text: `There is no skill named "${name}".` }
      const e = await makeEdit(name, change)
      if (!e.ok) return { ok: false, text: `Not changed: ${e.error}.` }
      const p = e.pending
      const risk = p.widens ? 'high' : 'medium'
      const yes = await deps.confirm(p.line.replace(/ Say “save it”.*$/, ''), risk)
      if (!yes) return { ok: true, text: 'The user said no; the skill stays as it was.' }
      return applyEdit(p)
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
/** What the app gives skill making beyond the recorder (presence, the confirm card). */
export interface CreationHost {
  canSpeakUp?(): boolean
  notice?(text: string): void
  confirm?(summary: string, risk: 'low' | 'medium' | 'high'): Promise<boolean>
  connectors?(): string[]
}

export function installSkillCreation(
  startRecording: CreationDeps['startRecording'],
  host: CreationHost = {}
): SkillCreation {
  const connectorList = async (): Promise<{ id: string; name: string }[]> =>
    host.connectors ? host.connectors().map((id) => ({ id, name: id })) : connectorChoices()
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
    handled: LOCAL_HANDLED,
    compose: async (description) => {
      const known = await connectorList()
      return authorSkill(
        {
          description,
          apps: appIds(),
          connectors: known.map((c) => c.id),
          connectorNames: Object.fromEntries(known.map((c) => [c.id, c.name]))
        },
        { taken: (n) => !!getSkillRegistry()?.get(n) }
      )
    },
    editLimits: async () => ({
      apps: appIds(),
      connectors: (await connectorList()).map((c) => c.id)
    }),
    editWords: async (turn) => {
      const { llm, model, effort } = getProvider('main')
      const res = await llm.complete(
        {
          model,
          system: [{ text: EDIT_PROMPT, cacheable: true }],
          messages: [{ role: 'user', content: turn }],
          maxTokens: 4000,
          effort,
          schema: editSchema,
          schemaName: 'lumen_skill_edit'
        },
        AbortSignal.timeout(45_000)
      )
      return (res.data as EditOutput | undefined) ?? null
    },
    skills: () =>
      getSkillRegistry()
        ?.all()
        .map((s) => ({ name: s.manifest.name, triggers: s.manifest.triggers })) ?? [],
    skillText: (name) => {
      const s = getSkillRegistry()?.get(name)
      if (!s) return null
      try {
        return { text: readSkillText(join(s.dir, SKILL_FILE)), hasSteps: s.hasSteps }
      } catch {
        return null
      }
    },
    saveEdit: (name, files) => {
      const registry = getSkillRegistry()
      if (!registry) return { ok: false, error: 'skills are not ready yet' }
      const r = saveSkillFiles(registry, name, files)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
    goodRuns: skillGoodRuns,
    proposals: new ProposalStore(join(homedir(), '.ai-overlay', 'skills-proposals.json'), {
      key: proposalKey(join(homedir(), '.ai-overlay', 'skills-proposals.key')),
      canRecord: proposalsMayRecord
    }),
    covered: (prompt) => matchTrigger(prompt)?.kind === 'skill',
    ...(host.canSpeakUp ? { canSpeakUp: host.canSpeakUp } : {}),
    ...(host.notice ? { notice: host.notice } : {}),
    ...(host.confirm ? { confirm: host.confirm } : {})
  })
  const created = instance
  setSkillAuthoringHost(created)
  onSkillRun((name, run) => created.skillRan(name, run, skillRuns(name)))
  bus.on('agent.task', (e) =>
    created.noteTask(e.task ? { prompt: e.task.prompt, phase: e.task.phase } : null)
  )
  return instance
}

/** App-pack ids the model may name for a skill's apps. */
function appIds(): string[] {
  const registry = getSkillRegistry()
  if (!registry) return []
  try {
    return [...new Set(registry.all().flatMap((s) => s.manifest.apps))].slice(0, 60)
  } catch {
    return []
  }
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

/** The foreground agent task (bus agent.task), for corrections and failed attempts. */
export function noteAgentTask(task: { prompt: string; phase: string } | null): void {
  instance?.noteTask(task)
}

/** The skill-making instance (agent tools, Settings); null before install. */
export function skillCreation(): SkillCreation | null {
  return instance
}
