// Making buddies by voice (08 T51): "make a buddy that …", "make me a buddy for …", "create a
// buddy called X that …" → the model's draft (compose.ts) → a spoken summary with its
// permissions and proposed schedule → the review: "save it", "call it …", "read it back",
// "discard it" (the skill draft review's words). Voice edits (edit.ts): "tell Inbox Buddy to
// also check Outlook", "change Price Buddy to run at 9", "make Inbox Buddy more brief" → the
// model's change, wider permissions spoken first → the same review; "rename X to Y" right away.
// The offer "Want a buddy for this?" (offers.ts) is answered here too.
//
// The pipeline calls buddyCreationTurn before its own buddy calling grammar; false = not a
// creation turn. The app wiring (ipc-create.ts) installs the instance; schedules go through the
// scheduler port (setBuddyScheduler, T52's automations with action buddy).
import type { Buddy, BuddyDraft, BuddySchedule } from '@shared/buddies'
import { matchDraftCommand } from '../skills/authoring'
import { matchOfferAnswer } from '../skills/proposals'
import { buddyFields, buddyPermissionWords, freeBuddyName, type AuthorBuddyResult } from './compose'
import { diffBuddy, editedDraft, matchBuddyEditIntent, type BuddyEditOutput } from './edit'
import { OFFER_LINE, matchOffersSwitch, type BuddyOfferStore, type OfferVerdict } from './offers'

export interface BuddyTurnCtx {
  /** Speaks and shows a line on the bar (the turn's answer). */
  say(text: string): void
  /**
   * The bar's confirm card; resolves true on yes. Asked before saving a change that gives a
   * buddy more than it had. Left out = the spoken review alone decides.
   */
  showCard?(summary: string, risk: 'low' | 'medium' | 'high'): Promise<boolean>
  /** A line under the presence rule (offers). */
  notice?(text: string): void
  /** The user is around and not in quiet mode. */
  canSpeakUp?(): boolean
  now?(): number
  log?(msg: string): void
}

/**
 * Creates, replaces (a schedule) or removes (null) the automation that starts a buddy. Returns
 * a short line for the user ("It runs every weekday at 08:00.").
 */
export type BuddyScheduler = (
  buddy: Buddy,
  schedule: BuddySchedule | null
) => Promise<{ ok: boolean; text: string }>

export interface BuddyCreationDeps {
  now(): number
  log(msg: string): void
  compose(description: string, name?: string): Promise<AuthorBuddyResult>
  /** The model's change of a buddy; null when it fails. */
  editWords(buddy: Buddy, change: string): Promise<BuddyEditOutput | null>
  /** Connector ids an edited buddy may name. */
  connectors(): Promise<string[]>
  resolveFolder?(name: string): string | null
  find(name: string): Buddy | null
  create(draft: BuddyDraft): { ok: true; buddy: Buddy } | { ok: false; error: string }
  update(id: string, patch: Partial<Omit<Buddy, 'id' | 'trust' | 'createdAt'>>): Buddy | null
  scheduler?(): BuddyScheduler | null
  offers?: BuddyOfferStore
}

/** A draft waits this long for "save it" / "call it …". */
export const BUDDY_DRAFT_MS = 10 * 60_000
/** A bare "yes" only counts this soon after the draft or offer. */
export const BUDDY_YES_MS = 2 * 60_000

type Pending =
  | { kind: 'new'; draft: BuddyDraft; at: number }
  | {
      kind: 'edit'
      id: string
      name: string
      draft: BuddyDraft
      /** A new schedule, null = stop running by itself, undefined = keep. */
      schedule?: BuddySchedule | null
      summary: string
      lines: string[]
      widens: boolean
      at: number
    }

const norm = (s: string): string =>
  s
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:ok|okay|hey lumen|lumen|please)[,\s]+/i, '')
    .replace(/[.!?]+$/, '')

const COMPOSE_RE =
  /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:make|create|build|set up|add|give)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+)?(?:little\s+)?buddy(?:\s+(?:called|named)\s+(.+?))?\s*(?:that|which|who|to|for|so that|so|:|-)\s*(.{4,})$/i
const NAMED_ONLY_RE =
  /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:make|create|build|set up|add)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+)?buddy\s+(?:called|named)\s+(.+)$/i

/** "make a buddy that …" → description (+ name for "called X"). */
export function matchBuddyComposeIntent(
  utterance: string
): { description: string; name?: string } | null {
  if (!utterance || utterance.length > 600) return null
  const n = norm(utterance)
  const m = COMPOSE_RE.exec(n)
  if (m) {
    const name = m[1]?.trim().replace(/^["“]|["”]$/g, '')
    return { description: m[2].trim(), ...(name ? { name } : {}) }
  }
  const named = NAMED_ONLY_RE.exec(n)
  if (named) return { description: '', name: named[1].trim() }
  return null
}

/** A name the user said: "mail buddy" → "Mail Buddy". */
export function titleName(raw: string): string {
  return raw
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .slice(0, 37)
}

/** The spoken summary of a new draft. */
export function draftLine(d: BuddyDraft): string {
  const when = d.schedule
    ? ` It would run ${d.schedule.description}.`
    : ' It runs when you call it.'
  return `Draft buddy “${d.name}”: ${d.description} ${buddyPermissionWords(d.permissions)}${when} Say “save it”, “call it” and a name, “read it back”, or “discard it”.`
}

export interface BuddyCreation {
  turn(text: string, ctx: BuddyTurnCtx): Promise<boolean>
  /** A finished request (foreground or background task): maybe "Want a buddy for this?". */
  noteRequest(prompt: string, ctx: Pick<BuddyTurnCtx, 'notice' | 'canSpeakUp'>): void
  pending(): BuddyDraft | null
}

export function createBuddyCreation(deps: BuddyCreationDeps): BuddyCreation {
  let pending: Pending | null = null
  let offered: (OfferVerdict & { at: number }) | null = null

  const isBuddy = (target: string): boolean => !!findRef(target)
  /** "inbox buddy", "the inbox", "Inbox" → Inbox Buddy. */
  function findRef(target: string): Buddy | null {
    const t = target.replace(/^(?:my|the)\s+/i, '').trim()
    return deps.find(t) ?? (/\bbuddy$/i.test(t) ? null : deps.find(`${t} buddy`))
  }

  function offer(draft: BuddyDraft): string {
    pending = { kind: 'new', draft, at: deps.now() }
    deps.log(`buddy draft "${draft.name}"`)
    return draftLine(draft)
  }

  async function compose(description: string, name?: string): Promise<string> {
    const said = name ? titleName(name) : undefined
    const r = await deps.compose(
      said ? `${description} (the user wants it called “${said}”)` : description,
      said
    )
    if (!r.ok) return `I could not write that buddy: ${r.error}.`
    if (r.warnings.length) deps.log(`buddy draft notes: ${r.warnings.join('; ')}`)
    if (said) r.draft.name = freeBuddyName(said, (n) => !!deps.find(n))
    return offer(r.draft)
  }

  async function saveNew(p: Extract<Pending, { kind: 'new' }>, name?: string): Promise<string> {
    if (name) p.draft.name = freeBuddyName(titleName(name), (n) => !!deps.find(n))
    const r = deps.create(p.draft)
    if (!r.ok) return `I could not save the buddy: ${r.error}.`
    pending = null
    deps.log(`buddy ${r.buddy.id} saved from a draft`)
    let when = ''
    if (p.draft.schedule) {
      const s = deps.scheduler?.()
      if (s) {
        const res = await s(r.buddy, p.draft.schedule).catch((e: Error) => ({
          ok: false,
          text: `I could not set its schedule (${e.message}).`
        }))
        when = ` ${res.text}`
      } else
        when = ` Its schedule, ${p.draft.schedule.description}, can be set in Settings, Buddies.`
    }
    return `Saved “${r.buddy.name}”. Say “${r.buddy.name}, …” to give it work.${when}`
  }

  async function saveEdit(
    p: Extract<Pending, { kind: 'edit' }>,
    ctx: BuddyTurnCtx
  ): Promise<string> {
    if (p.widens && ctx.showCard) {
      const ok = await ctx.showCard(`Let ${p.name} do more? ${p.lines[0]}`, 'medium')
      if (!ok) {
        pending = null
        return `Change discarded. ${p.name} stays as it was.`
      }
    }
    const f = buddyFields(p.draft)
    const b = deps.update(p.id, {
      instructions: f.instructions,
      permissions: f.permissions,
      model: f.model,
      report: f.report
    })
    if (pending === p) pending = null
    if (!b) return `I could not change ${p.name}: it is gone.`
    deps.log(`buddy ${p.id} changed`)
    let when = ''
    if (p.schedule !== undefined) {
      const s = deps.scheduler?.()
      if (s) {
        const res = await s(b, p.schedule).catch((e: Error) => ({
          ok: false,
          text: `I could not change its schedule (${e.message}).`
        }))
        when = ` ${res.text}`
      } else when = ' Change its schedule in Settings, Buddies.'
    }
    return `Saved the change to ${b.name}.${when}`
  }

  async function review(text: string, ctx: BuddyTurnCtx): Promise<string | undefined> {
    const p = pending
    if (!p) return undefined
    const age = deps.now() - p.at
    if (age > BUDDY_DRAFT_MS) {
      pending = null
      return undefined
    }
    const c = matchDraftCommand(text)
    if (!c || c.cmd === 'trigger') return undefined
    if (p.kind === 'edit') {
      switch (c.cmd) {
        case 'yes':
          return age <= BUDDY_YES_MS ? saveEdit(p, ctx) : undefined
        case 'save':
          return saveEdit(p, ctx)
        case 'read':
          p.at = deps.now()
          return [p.summary, ...p.lines].join(' ')
        case 'discard':
          pending = null
          return `Change discarded. ${p.name} stays as it was.`
        default:
          return `To rename it, save or discard this change first.`
      }
    }
    switch (c.cmd) {
      case 'yes':
        return age <= BUDDY_YES_MS ? saveNew(p) : undefined
      case 'save':
        return saveNew(p, c.name)
      case 'rename': {
        const name = freeBuddyName(titleName(c.name), (n) => !!deps.find(n))
        p.draft.name = name
        p.at = deps.now()
        return `Renamed it to “${name}”. Say “save it” to keep it.`
      }
      case 'read':
        p.at = deps.now()
        return `${p.draft.name}. ${p.draft.instructions.replace(/\n+/g, ' ')} ${buddyPermissionWords(p.draft.permissions)}${p.draft.schedule ? ` It would run ${p.draft.schedule.description}.` : ''}`
      case 'discard':
        pending = null
        return 'Draft buddy discarded.'
    }
  }

  async function edit(target: Buddy, change: string): Promise<string> {
    let out: BuddyEditOutput | null
    try {
      out = await deps.editWords(target, change)
    } catch (e) {
      deps.log(`buddy edit failed: ${(e as Error).message}`)
      out = null
    }
    if (!out) return `I could not change ${target.name} right now.`
    const r = editedDraft(
      target,
      out,
      { connectors: await deps.connectors().catch(() => []) },
      {
        now: deps.now(),
        ...(deps.resolveFolder ? { resolveFolder: deps.resolveFolder } : {})
      }
    )
    if (r.warnings.length) deps.log(`buddy edit notes: ${r.warnings.join('; ')}`)
    const diff = diffBuddy(target, r.draft)
    if (r.schedule === null) diff.lines.push('It stops running by itself.')
    else if (r.schedule) diff.lines.push(`It would run ${r.schedule.description}.`)
    if (!diff.lines.length) return `That would not change ${target.name}.`
    const summary = out.summary.replace(/\s+/g, ' ').trim().slice(0, 200)
    pending = {
      kind: 'edit',
      id: target.id,
      name: target.name,
      draft: r.draft,
      ...(r.schedule !== undefined ? { schedule: r.schedule } : {}),
      summary,
      lines: diff.lines,
      widens: diff.widens,
      at: deps.now()
    }
    const widen = diff.lines.slice(0, diff.widenCount).join(' ')
    return `${summary}${widen ? ` ${widen}` : ''}${r.schedule !== undefined ? ` ${diff.lines[diff.lines.length - 1]}` : ''} Say “save it”, “read it back” or “discard it”.`
  }

  function rename(target: Buddy, raw: string): string {
    const name = titleName(raw)
    if (!/\p{L}/u.test(name)) return 'That name has no letters I can use. Try another.'
    const other = deps.find(name)
    if (other && other.id !== target.id) return `You already have a buddy called ${other.name}.`
    const b = deps.update(target.id, { name })
    return b ? `Renamed ${target.name} to ${b.name}.` : `I could not rename ${target.name}.`
  }

  async function answerOffer(text: string): Promise<string | undefined> {
    const o = offered
    if (!o) return undefined
    if (deps.now() - o.at > BUDDY_YES_MS + 60_000) {
      offered = null
      return undefined
    }
    const a = matchOfferAnswer(text)
    if (!a) return undefined
    offered = null
    if (a === 'yes') {
      deps.offers?.answered(o.words, 'yes', deps.now())
      return compose(`A buddy that does this for me regularly: ${o.prompt}`)
    }
    deps.offers?.answered(o.words, 'no', deps.now())
    if (a === 'never') {
      deps.offers?.setOff(true)
      return 'Okay, I will stop offering buddies. Say “start offering buddies again” to undo that.'
    }
    return 'Okay, I will not ask about this one again.'
  }

  async function turn(text: string, ctx: BuddyTurnCtx): Promise<boolean> {
    const words = text.trim()
    if (!words) return false
    const reply = await (async (): Promise<string | undefined> => {
      const sw = matchOffersSwitch(words)
      if (sw && deps.offers) {
        deps.offers.setOff(sw === 'off')
        return sw === 'off'
          ? 'Okay, I will stop offering buddies.'
          : 'Okay, I may offer a buddy again when you ask for the same thing twice.'
      }
      const o = await answerOffer(words)
      if (o !== undefined) return o
      const r = await review(words, ctx)
      if (r !== undefined) return r
      const make = matchBuddyComposeIntent(words)
      if (make) {
        if (!make.description)
          return `What should ${titleName(make.name ?? 'it')} do? Say “make a buddy called ${titleName(make.name ?? 'X')} that …”.`
        return compose(make.description, make.name)
      }
      const e = matchBuddyEditIntent(words, isBuddy)
      if (e) {
        const b = findRef(e.target)
        if (!b) return undefined
        return e.kind === 'rename' ? rename(b, e.name) : edit(b, e.change)
      }
      return undefined
    })()
    if (reply === undefined) return false
    ctx.say(reply)
    return true
  }

  function noteRequest(prompt: string, ctx: Pick<BuddyTurnCtx, 'notice' | 'canSpeakUp'>): void {
    const store = deps.offers
    if (!store) return
    const v = store.consider(prompt, { now: deps.now() })
    if (!v || pending || offered || (ctx.canSpeakUp && !ctx.canSpeakUp()) || !ctx.notice) return
    offered = { ...v, at: deps.now() }
    store.answered(v.words, 'offered', deps.now())
    deps.log('offering a buddy for a repeated request')
    ctx.notice(OFFER_LINE)
  }

  return {
    turn,
    noteRequest,
    pending: () => (pending?.kind === 'new' ? pending.draft : null)
  }
}

let instance: BuddyCreation | null = null
let scheduler: BuddyScheduler | null = null

/** The app's instance (ipc-create.ts installs it). */
export function setBuddyCreation(c: BuddyCreation | null): void {
  instance = c
}

export function buddyCreation(): BuddyCreation | null {
  return instance
}

/** T52: creates / replaces / removes a buddy's automation (action buddy). */
export function setBuddyScheduler(fn: BuddyScheduler | null): void {
  scheduler = fn
}

export function buddyScheduler(): BuddyScheduler | null {
  return scheduler
}

/** Handles a buddy creation / review / edit turn; false when the words are not one. */
export async function buddyCreationTurn(text: string, ctx: BuddyTurnCtx): Promise<boolean> {
  return instance ? instance.turn(text, ctx) : false
}
