// The spoken replies of voice management: resolves the names in a parsed command against the
// live lists (through ports, so tests use fakes), asks "Which one: A or B?" when a name fits
// several things and takes the answer in the next turn, and puts every destructive step behind
// the bar's confirm card (answered with yes / no by voice).
import type { ChatControlOp, ChatHeader, ChatSteerResult, ChatSummary } from '@shared/task-chat'
import { agoText } from '../buddies/voice'
import { parseManageCommand, type ManageCommand, type TaskOp } from './grammar'
import { andList, matchNamed, orList, resolveWhich, type Named } from './match'

export interface ManageAnswer {
  mode: 'answer'
  text: string
  spoken: string
}

export type ManageReply = ManageAnswer | Promise<ManageAnswer>

export interface ManageDeps {
  now(): number
  /** The bar's confirm card; true on yes. */
  confirm(summary: string, risk: 'low' | 'medium' | 'high'): Promise<boolean>
  /** A confirm card is up (its own yes / no answers it). */
  confirmPending(): boolean
  tasks: {
    list(): ChatSummary[]
    header(id: string): ChatHeader | null
    control(id: string, op: ChatControlOp, token?: string): ChatSteerResult
  }
  automations: {
    list(): { id: string; name: string; enabled: boolean; triggerText: string; running: boolean }[]
    setEnabled(id: string, on: boolean): boolean
    remove(id: string): boolean
    runNow(id: string): boolean
  }
  buddies: {
    list(): { id: string; name: string }[]
    remove(id: string): boolean
  }
  skills: {
    list(): { name: string; enabled: boolean; origin: string; triggers: string[] }[]
    setEnabled(name: string, on: boolean): boolean
    remove(name: string): { ok: boolean; error?: string }
  }
  grants: {
    list(): { scope: string }[]
    revoke(scope: string): boolean
  }
  audit: {
    /** Actions between the two times: done (result ok) or not, in plain words. */
    entries(from: number, to: number): { ok: boolean; text: string }[]
  }
  notes: {
    /** Newest first. */
    list(): { id: string; t: number; text: string }[]
    remove(id: string): boolean
  }
  memory: {
    export(): Promise<{ ok: boolean; path?: string; error?: string }>
    deleteAll(): { ok: boolean; error?: string }
  }
  connectors: {
    list(): {
      id: string
      name: string
      transport: string
      enabled: boolean
      state: string
      auth?: string
      signedIn?: boolean
    }[]
    test(id: string): Promise<{ ok: boolean; toolCount?: number; error?: string }>
    signIn(id: string): Promise<{ ok: boolean; error?: string }>
    /** Says how a sign-in ended (it finishes after this turn). */
    notify(text: string): void
  }
  guides: {
    list(): { id: string; name: string }[]
    remove(id: string): boolean
  }
  diagnostics: {
    export(): Promise<{ ok: boolean; path?: string; error?: string }>
  }
}

const WHICH_MS = 60_000
const MAX_SPOKEN = 5

const answer = (text: string, spoken = text.replace(/^- /gm, '')): ManageAnswer => ({
  mode: 'answer',
  text,
  spoken
})

const quote = (s: string): string => `“${s}”`

const cut = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** "a, b, c and 2 more". */
function someOf(names: string[], max = MAX_SPOKEN): string {
  if (names.length <= max) return andList(names)
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`
}

const OPEN = new Set(['queued', 'running', 'paused', 'asking', 'confirm'])

const PHASE_WORDS: Record<string, string> = {
  queued: 'waiting to start',
  running: 'working',
  paused: 'paused',
  asking: 'waiting for your answer',
  confirm: 'waiting for your OK'
}

const TASK_NOISE = new Set(['task', 'tasks', 'job', 'background'])
const AUTOMATION_NOISE = new Set(['automation', 'routine', 'reminder'])
const SKILL_NOISE = new Set(['skill'])
const BUDDY_NOISE = new Set(['buddy', 'buddie', 'buddies', 'body'])
const CONNECTOR_NOISE = new Set(['connector'])
const GUIDE_NOISE = new Set(['guide', 'saved'])
const GRANT_NOISE = new Set(['app', 'site', 'website', 'tool', 'links', 'exe'])

/** "app:outlook.exe" → "the app outlook", with short names to match. */
export function grantLabel(scope: string): { label: string; names: string[] } {
  const i = scope.indexOf(':')
  const kind = scope.slice(0, i)
  const v = scope.slice(i + 1)
  switch (kind) {
    case 'app': {
      const app = v.replace(/\.exe$/i, '')
      return { label: `the app ${app}`, names: [app] }
    }
    case 'domain': {
      const host = v.replace(/^\*\./, '').replace(/^www\./, '')
      return { label: `the site ${host}`, names: [host, host.split('.')[0]] }
    }
    case 'mcp': {
      const [server, tool] = v.split('/')
      return {
        label: `the ${server} connector${tool ? `’s ${tool.replace(/_/g, ' ')}` : ''}`,
        names: [`${server} ${tool ?? ''}`.trim(), server]
      }
    }
    case 'scheme':
      return v === 'mailto'
        ? { label: 'email links', names: ['email', 'mailto', 'email links'] }
        : { label: `${v} links`, names: [v] }
    default:
      return { label: scope, names: [scope] }
  }
}

/** Local midnight of the day `now` is in. */
function dayStart(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

interface Waiting {
  options: Named[]
  run: (id: string) => ManageReply
  until: number
}

export class ManageVoice {
  private waiting: Waiting | null = null

  constructor(private readonly d: ManageDeps) {}

  /** The reply when the words manage something; null when they are not ours. */
  turn(text: string): ManageReply | null {
    const w = this.waiting
    this.waiting = null
    if (w && this.d.now() < w.until) {
      const id = resolveWhich(text, w.options)
      if (id) return w.run(id)
    }
    const cmd = parseManageCommand(text)
    return cmd ? this.run(cmd) : null
  }

  /** One fits: run it; several: ask which and run the answer next turn. */
  private pick(
    ids: string[],
    options: Named[],
    run: (id: string) => ManageReply,
    noun: string
  ): ManageReply {
    if (ids.length === 1) return run(ids[0])
    const opts = ids.map((id) => options.find((o) => o.id === id)).filter((o): o is Named => !!o)
    this.waiting = { options: opts, run, until: this.d.now() + WHICH_MS }
    return answer(`Which ${noun}: ${orList(opts.map((o) => o.name))}?`)
  }

  private run(cmd: ManageCommand): ManageReply | null {
    switch (cmd.kind) {
      case 'tasks-list':
        return this.tasksList()
      case 'task-control':
        return this.taskControl(cmd.op, cmd.name)
      case 'tasks-all':
        return this.tasksAll(cmd.op, cmd.background)
      case 'task-question':
        return this.taskQuestion(cmd.name)
      case 'task-answer':
        return this.taskAnswer(cmd.approve, cmd.name)
      case 'automation-enable':
      case 'automation-delete':
      case 'automation-run':
        return this.automation(cmd)
      case 'skills-list':
        return this.skillsList()
      case 'skill-enable':
      case 'skill-delete':
        return this.skill(cmd)
      case 'buddy-delete':
        return this.buddyDelete(cmd.name)
      case 'grants-list':
        return this.grantsList()
      case 'grant-revoke':
        return this.grantRevoke(cmd.name)
      case 'grants-revoke-all':
        return this.grantsRevokeAll()
      case 'audit-day':
        return this.auditDay(cmd.day)
      case 'notes-read':
        return this.notesRead(cmd.last)
      case 'note-delete-last':
        return this.noteDeleteLast()
      case 'memory-export':
        return this.memoryExport()
      case 'memory-delete-all':
        return this.memoryDeleteAll()
      case 'connectors-list':
        return this.connectorsList()
      case 'connector-test':
        return this.connectorTest(cmd.name)
      case 'connector-sign-in':
        return this.connectorSignIn(cmd.name, cmd.loose)
      case 'guides-list':
        return this.guidesList()
      case 'guide-delete':
        return this.guideDelete(cmd.name)
      case 'diagnostics-export':
        return this.diagnosticsExport()
    }
  }

  // ---- tasks ----

  private tasksList(): ManageAnswer {
    const open = this.d.tasks.list().filter((r) => OPEN.has(r.phase))
    if (!open.length) return answer('I’m not working on anything right now.')
    const lines = open.map((r) => `${r.title}: ${PHASE_WORDS[r.phase] ?? r.phase}`)
    const head =
      open.length === 1 ? 'I’m working on one thing:' : `I’m working on ${open.length} things:`
    const more = open.length > MAX_SPOKEN ? ` And ${open.length - MAX_SPOKEN} more.` : ''
    return answer(
      [head, ...lines.map((l) => `- ${l}`)].join('\n'),
      `${head} ${lines.slice(0, MAX_SPOKEN).join('. ')}.${more}`
    )
  }

  /** The task rows the name fits (one row per title: open ones and the newest come first). */
  private taskRows(
    name: string,
    rows = this.d.tasks.list()
  ): { rows: ChatSummary[]; ids: string[] } {
    const seen = new Set<string>()
    const unique = rows.filter((r) => {
      const k = r.title.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    const m = matchNamed(
      name,
      unique.map((r) => ({ id: r.id, name: r.title })),
      TASK_NOISE
    )
    return { rows: unique, ids: m.ids }
  }

  private taskControl(op: TaskOp, name: string): ManageReply {
    const all = this.d.tasks.list()
    const can = (id: string): boolean => {
      const h = this.d.tasks.header(id)
      if (!h) return false
      return op === 'stop'
        ? h.canStop
        : op === 'pause'
          ? h.canPause
          : op === 'resume'
            ? h.canResume
            : h.canRunAgain
    }
    // Rows the action fits first ("stop the email task" means the running one).
    const named = all.filter(
      (r) => matchNamed(name, [{ id: r.id, name: r.title }], TASK_NOISE).tier > 0
    )
    const { rows, ids } = this.taskRows(
      name,
      named.filter((r) => can(r.id))
    )
    if (!ids.length) {
      const any = this.taskRows(name, all)
      if (!any.ids.length)
        return answer(
          all.length ? `I don’t see a task like ${quote(name)}.` : 'There are no tasks right now.'
        )
      const t = any.rows.find((r) => r.id === any.ids[0])!
      return answer(
        op === 'run-again'
          ? `${quote(t.title)} is still going. Say “stop the ${name} task” first.`
          : op === 'resume'
            ? `${quote(t.title)} isn’t paused.`
            : op === 'pause' && OPEN.has(t.phase)
              ? `${quote(t.title)} can’t pause right now.`
              : `${quote(t.title)} isn’t running.`
      )
    }
    const options = rows.map((r) => ({ id: r.id, name: r.title }))
    const run = (id: string): ManageAnswer => {
      const t = options.find((o) => o.id === id)?.name ?? 'That task'
      const r = this.d.tasks.control(id, op)
      if (!r.ok) return answer(r.error ?? `I couldn’t do that with ${quote(t)}.`)
      switch (op) {
        case 'stop':
          return answer(`Stopped ${quote(t)}.`)
        case 'pause':
          return answer(`Paused ${quote(t)}. Say “resume the ${name} task” to go on.`)
        case 'resume':
          return answer(`${quote(t)} is going on.`)
        case 'run-again':
          return answer(`Running ${quote(t)} again.`)
      }
    }
    return this.pick(ids, options, run, 'task')
  }

  private tasksAll(op: Exclude<TaskOp, 'run-again'>, backgroundOnly: boolean): ManageAnswer {
    const rows = this.d.tasks
      .list()
      .filter(
        (r) =>
          r.kind !== 'claude' && OPEN.has(r.phase) && (!backgroundOnly || r.kind === 'background')
      )
    let n = 0
    for (const r of rows) {
      const h = this.d.tasks.header(r.id)
      if (!h) continue
      const fits = op === 'stop' ? h.canStop : op === 'pause' ? h.canPause : h.canResume
      if (fits && this.d.tasks.control(r.id, op).ok) n++
    }
    const what = n === 1 ? 'one task' : `${n} tasks`
    if (!n) return answer(op === 'resume' ? 'No task is paused.' : 'No task is running right now.')
    return answer(
      op === 'stop' ? `Stopped ${what}.` : op === 'pause' ? `Paused ${what}.` : `Resumed ${what}.`
    )
  }

  /** Open rows with a question or a confirm card waiting. */
  private waitingRows(): { row: ChatSummary; h: ChatHeader }[] {
    const out: { row: ChatSummary; h: ChatHeader }[] = []
    for (const row of this.d.tasks.list()) {
      if (!OPEN.has(row.phase)) continue
      const h = this.d.tasks.header(row.id)
      if (h && (h.question || h.confirmId)) out.push({ row, h })
    }
    return out
  }

  private questionText(h: ChatHeader): string {
    if (h.confirmId)
      return `${quote(h.title)} wants your OK: ${cut(h.confirm ?? 'an action', 300)}. Say “approve it” or “deny it”.`
    const q = h.question!
    const choices = q.choices.length ? ` Choices: ${orList(q.choices)}.` : ''
    const how = q.choices.length
      ? ' Say “approve it” or “deny it”.'
      : ` To answer, say “tell the ${h.title.split(' ').slice(0, 3).join(' ').toLowerCase()} task” and your answer.`
    return `${quote(h.title)} asks: ${cut(q.text, 400)}${choices}${how}`
  }

  private taskQuestion(name: string): ManageReply {
    const waiting = this.waitingRows()
    if (!name) {
      if (!waiting.length) return answer('No task is waiting for you.')
      if (waiting.length === 1) return answer(this.questionText(waiting[0].h))
      return answer(
        `${waiting.length} tasks are waiting: ${someOf(waiting.map((w) => quote(w.row.title)))}. Ask “what’s the … task asking”.`
      )
    }
    const { rows, ids } = this.taskRows(name)
    if (!ids.length) return answer(`I don’t see a task like ${quote(name)}.`)
    const options = rows.map((r) => ({ id: r.id, name: r.title }))
    return this.pick(
      ids,
      options,
      (id) => {
        const h = this.d.tasks.header(id)
        if (!h) return answer('That task is gone.')
        if (!h.question && !h.confirmId) return answer(`${quote(h.title)} isn’t asking anything.`)
        return answer(this.questionText(h))
      },
      'task'
    )
  }

  private taskAnswer(approve: boolean, name: string): ManageReply | null {
    const decide = (h: ChatHeader): ManageAnswer => {
      if (!h.confirmId && !h.question?.choices.length)
        return answer(
          h.question
            ? `${quote(h.title)} needs a spoken answer: ${cut(h.question.text, 200)} Say “tell the task” and your answer.`
            : `${quote(h.title)} isn’t asking anything.`
        )
      const token = h.confirmId ?? h.question?.token
      const r = this.d.tasks.control(h.id, approve ? 'approve' : 'deny', token)
      if (!r.ok) return answer(r.error ?? 'That question is gone.')
      return answer(approve ? `Approved for ${quote(h.title)}.` : `Denied for ${quote(h.title)}.`)
    }
    if (!name) {
      const waiting = this.waitingRows()
      if (!waiting.length)
        // A confirm card on the bar answers its own "approve it"; nothing else is ours.
        return this.d.confirmPending() ? null : answer('Nothing is waiting for an answer.')
      if (waiting.length === 1) return decide(waiting[0].h)
      return this.pick(
        waiting.map((w) => w.row.id),
        waiting.map((w) => ({ id: w.row.id, name: w.row.title })),
        (id) => {
          const h = this.d.tasks.header(id)
          return h ? decide(h) : answer('That task is gone.')
        },
        'task'
      )
    }
    const { rows, ids } = this.taskRows(
      name,
      this.waitingRows().map((w) => w.row)
    )
    if (!ids.length) return answer(`No task like ${quote(name)} is waiting for an answer.`)
    return this.pick(
      ids,
      rows.map((r) => ({ id: r.id, name: r.title })),
      (id) => {
        const h = this.d.tasks.header(id)
        return h ? decide(h) : answer('That task is gone.')
      },
      'task'
    )
  }

  // ---- automations ----

  private automation(
    cmd: Extract<
      ManageCommand,
      { kind: 'automation-enable' | 'automation-delete' | 'automation-run' }
    >
  ): ManageReply | null {
    const list = this.d.automations.list()
    const options = list.map((a) => ({ id: a.id, name: a.name }))
    const m = matchNamed(cmd.name, options, AUTOMATION_NOISE)
    if (cmd.kind === 'automation-run') {
      // "run X now": buddies, skills and the model take whatever is not one of the automations.
      if (!m.ids.length || (cmd.loose && m.tier < 2)) return null
      if (cmd.loose && matchNamed(cmd.name, this.d.buddies.list(), BUDDY_NOISE).ids.length)
        return null
    }
    if (!m.ids.length)
      return answer(
        list.length
          ? `I don’t have an automation called ${quote(cmd.name)}. Yours: ${someOf(list.map((a) => a.name))}.`
          : 'You have no automations yet.'
      )
    const byId = (id: string): (typeof list)[number] | undefined => list.find((a) => a.id === id)
    const run = (id: string): ManageReply => {
      const a = byId(id)
      if (!a) return answer('That automation is gone.')
      switch (cmd.kind) {
        case 'automation-enable':
          if (a.enabled === cmd.on)
            return answer(`${quote(a.name)} is already ${cmd.on ? 'on' : 'off'}.`)
          if (!this.d.automations.setEnabled(a.id, cmd.on))
            return answer('That automation is gone.')
          return answer(
            cmd.on
              ? `${quote(a.name)} is on again.`
              : `Turned off ${quote(a.name)}. Say “turn on the ${a.name} automation” to start it again.`
          )
        case 'automation-delete':
          return this.d
            .confirm(`Delete the automation ${quote(a.name)} (${a.triggerText})?`, 'medium')
            .then((yes) => {
              if (!yes) return answer(`Okay, I kept ${quote(a.name)}.`)
              return this.d.automations.remove(a.id)
                ? answer(`Deleted the automation ${quote(a.name)}.`)
                : answer('That automation is gone.')
            })
        case 'automation-run':
          if (a.running) return answer(`${quote(a.name)} is already running.`)
          return this.d.automations.runNow(a.id)
            ? answer(`Running ${quote(a.name)} now.`)
            : answer(`${quote(a.name)} is already running.`)
      }
    }
    return this.pick(m.ids, options, run, 'automation')
  }

  // ---- skills ----

  private skillsList(): ManageAnswer {
    const list = this.d.skills.list()
    if (!list.length)
      return answer('You have no skills yet. Say “make a skill that …” to make one.')
    const names = list.map((s) => `${s.name.replace(/-/g, ' ')}${s.enabled ? '' : ' (off)'}`)
    const off = list.filter((s) => !s.enabled).length
    const head = `You have ${list.length === 1 ? 'one skill' : `${list.length} skills`}${off ? `, ${off} turned off` : ''}`
    return answer(
      `${head}:\n${names.map((n) => `- ${n}`).join('\n')}`,
      `${head}: ${someOf(names, 8)}.`
    )
  }

  private skill(
    cmd: Extract<ManageCommand, { kind: 'skill-enable' | 'skill-delete' }>
  ): ManageReply {
    const list = this.d.skills.list()
    const options = list.map((s) => ({
      id: s.name,
      name: s.name.replace(/-/g, ' '),
      aliases: s.triggers
    }))
    const m = matchNamed(cmd.name, options, SKILL_NOISE)
    if (!m.ids.length)
      return answer(
        `I don’t have a skill called ${quote(cmd.name)}. Ask “what skills do I have” to hear them.`
      )
    const run = (id: string): ManageReply => {
      const s = list.find((x) => x.name === id)
      if (!s) return answer('That skill is gone.')
      const shown = s.name.replace(/-/g, ' ')
      if (cmd.kind === 'skill-enable') {
        if (s.enabled === cmd.on)
          return answer(`The ${shown} skill is already ${cmd.on ? 'on' : 'off'}.`)
        return this.d.skills.setEnabled(s.name, cmd.on)
          ? answer(`The ${shown} skill is ${cmd.on ? 'on' : 'off'}.`)
          : answer('I couldn’t change that skill.')
      }
      if (s.origin === 'builtin')
        return answer(
          `The ${shown} skill comes with Lumen and can’t be deleted. Say “turn off the ${shown} skill” instead.`
        )
      return this.d.confirm(`Delete the skill ${quote(shown)}?`, 'medium').then((yes) => {
        if (!yes) return answer(`Okay, I kept the ${shown} skill.`)
        const r = this.d.skills.remove(s.name)
        return r.ok
          ? answer(`Deleted the ${shown} skill.`)
          : answer(`I couldn’t delete it: ${r.error ?? 'unknown error'}.`)
      })
    }
    return this.pick(m.ids, options, run, 'skill')
  }

  // ---- buddies ----

  private buddyDelete(name: string): ManageReply | null {
    const list = this.d.buddies.list()
    const m = matchNamed(name, list, BUDDY_NOISE)
    if (!m.ids.length) {
      // "remove the dead body" is not about buddies.
      if (!/\bbudd(?:y|ie)\b/.test(name)) return null
      return answer(
        list.length
          ? `I don’t have a buddy called ${quote(name)}. Your buddies: ${someOf(list.map((b) => b.name))}.`
          : 'You have no buddies yet.'
      )
    }
    const run = (id: string): ManageReply => {
      const b = list.find((x) => x.id === id)
      if (!b) return answer('That buddy is gone.')
      return this.d
        .confirm(`Delete ${b.name}? Its notebook and schedules go too.`, 'medium')
        .then((yes) => {
          if (!yes) return answer(`Okay, I kept ${b.name}.`)
          return this.d.buddies.remove(b.id)
            ? answer(`Deleted ${b.name}.`)
            : answer('That buddy is gone.')
        })
    }
    return this.pick(m.ids, list, run, 'buddy')
  }

  // ---- grants ----

  private grantsList(): ManageAnswer {
    const list = this.d.grants.list()
    if (!list.length)
      return answer('You haven’t always allowed anything. I ask each time it matters.')
    const labels = list.map((g) => grantLabel(g.scope).label)
    return answer(
      `You always allow:\n${labels.map((l) => `- ${l}`).join('\n')}\nSay “stop always allowing …” to take one back.`,
      `You always allow ${someOf(labels)}. Say “stop always allowing” and its name to take one back.`
    )
  }

  private grantRevoke(name: string): ManageReply {
    const list = this.d.grants.list()
    const options = list.map((g) => {
      const l = grantLabel(g.scope)
      return { id: g.scope, name: l.label, aliases: l.names }
    })
    const m = matchNamed(name, options, GRANT_NOISE)
    if (!m.ids.length)
      return answer(
        list.length
          ? `You haven’t always allowed ${quote(name)}. Ask “what have I always allowed” to hear the list.`
          : 'You haven’t always allowed anything.'
      )
    // Taking a permission back only narrows what Lumen may do: no confirm needed.
    return this.pick(
      m.ids,
      options,
      (id) => {
        const label = options.find((o) => o.id === id)?.name ?? id
        return this.d.grants.revoke(id)
          ? answer(`Okay, I’ll ask again before using ${label}.`)
          : answer('That permission is already gone.')
      },
      'one'
    )
  }

  private grantsRevokeAll(): ManageReply {
    const list = this.d.grants.list()
    if (!list.length) return answer('You haven’t always allowed anything.')
    const what =
      list.length === 1
        ? 'the one always-allow permission'
        : `all ${list.length} always-allow permissions`
    return this.d.confirm(`Revoke ${what}?`, 'medium').then((yes) => {
      if (!yes) return answer('Okay, I kept them.')
      let n = 0
      for (const g of list) if (this.d.grants.revoke(g.scope)) n++
      return answer(
        `Revoked ${n === 1 ? 'one permission' : `${n} permissions`}. I’ll ask again each time.`
      )
    })
  }

  // ---- the action log ----

  private auditDay(day: 'today' | 'yesterday'): ManageAnswer {
    const now = this.d.now()
    const today = dayStart(now)
    const from = day === 'today' ? today : dayStart(today - 1)
    const to = day === 'today' ? now + 1 : today
    const list = this.d.audit.entries(from, to)
    if (!list.length) return answer(`I didn’t do anything on your computer ${day}.`)
    const done = list.filter((e) => e.ok).length
    const notDone = list.length - done
    const head = `${day === 'today' ? 'Today' : 'Yesterday'} I took ${list.length === 1 ? 'one action' : `${list.length} actions`} on your computer${notDone ? `; ${notDone} ${notDone === 1 ? 'was' : 'were'} not done` : ''}.`
    const last = list.slice(-MAX_SPOKEN).map((e) => e.text)
    return answer(
      `${head}\nThe last ones:\n${last.map((l) => `- ${l}`).join('\n')}`,
      `${head} The last ones: ${last.join('; ')}.`
    )
  }

  // ---- notes ----

  private notesRead(last: boolean): ManageAnswer {
    const notes = this.d.notes.list()
    if (!notes.length) return answer('You have no notes. Say “take a note” and what to write.')
    const now = this.d.now()
    if (last) {
      const n = notes[0]
      return answer(`Your last note, from ${agoText(n.t, now)}: ${cut(n.text, 500)}`)
    }
    const shown = notes.slice(0, 3)
    const head = notes.length === 1 ? 'You have one note.' : `You have ${notes.length} notes.`
    const lines = shown.map((n, i) => `${i + 1}. ${cut(n.text, 200)}`)
    return answer(
      `${head}${notes.length > 1 ? ' The newest:' : ''}\n${lines.join('\n')}`,
      `${head}${notes.length > 1 ? ' The newest:' : ''} ${lines.join(' ')}`
    )
  }

  private noteDeleteLast(): ManageReply {
    const n = this.d.notes.list()[0]
    if (!n) return answer('You have no notes.')
    return this.d
      .confirm(`Delete your last note: ${quote(cut(n.text, 120))}?`, 'medium')
      .then((yes) => {
        if (!yes) return answer('Okay, I kept it.')
        return this.d.notes.remove(n.id)
          ? answer('Deleted your last note.')
          : answer('That note is gone.')
      })
  }

  // ---- memory ----

  private memoryExport(): ManageReply {
    return this.d.memory.export().then((r) => {
      if (!r.ok || !r.path)
        return answer(
          r.error === 'Nothing saved yet.'
            ? 'I haven’t remembered anything yet.'
            : (r.error ?? 'Export failed.')
        )
      const file = r.path.split(/[\\/]/).pop() ?? r.path
      return answer(
        `Saved your memory to your Downloads folder as ${file}.`,
        `Saved your memory to your Downloads folder.`
      )
    })
  }

  private memoryDeleteAll(): ManageReply {
    return this.d
      .confirm(
        'Delete everything Lumen remembers about you: your profile, app notes and past conversations? This can’t be undone.',
        'high'
      )
      .then((yes) => {
        if (!yes) return answer('Okay, I didn’t delete anything.')
        const r = this.d.memory.deleteAll()
        return r.ok
          ? answer('Done. I’ve forgotten everything I remembered about you.')
          : answer(r.error ?? 'I couldn’t delete the memory.')
      })
  }

  // ---- connectors ----

  private connectorsList(): ManageAnswer {
    const list = this.d.connectors.list()
    if (!list.length) return answer('You have no connectors. Add one in Settings, Connectors.')
    const words = (c: (typeof list)[number]): string =>
      !c.enabled
        ? 'off'
        : c.auth === 'oauth' && !c.signedIn
          ? 'needs sign-in'
          : c.state === 'connected'
            ? 'connected'
            : c.state === 'error'
              ? 'has a problem'
              : 'ready'
    const lines = list.map((c) => `${c.name}: ${words(c)}`)
    return answer(
      `Your connectors:\n${lines.map((l) => `- ${l}`).join('\n')}`,
      `Your connectors: ${someOf(lines)}.`
    )
  }

  private connectorTest(name: string): ManageReply {
    const list = this.d.connectors.list()
    const m = matchNamed(name, list, CONNECTOR_NOISE)
    if (!m.ids.length)
      return answer(
        list.length
          ? `I don’t have a connector called ${quote(name)}. Yours: ${someOf(list.map((c) => c.name))}.`
          : 'You have no connectors.'
      )
    return this.pick(
      m.ids,
      list,
      (id) => {
        const c = list.find((x) => x.id === id)!
        return this.d.connectors
          .test(id)
          .then((r) =>
            r.ok
              ? answer(
                  `${c.name} works: ${r.toolCount === 1 ? 'one tool' : `${r.toolCount ?? 0} tools`}.`
                )
              : answer(`${c.name} didn’t connect: ${cut(r.error ?? 'unknown error', 200)}`)
          )
      },
      'connector'
    )
  }

  private connectorSignIn(name: string, loose: boolean): ManageReply | null {
    const list = this.d.connectors.list()
    const m = matchNamed(name, list, CONNECTOR_NOISE)
    // "connect to the wifi", "sign in to Gmail" in the browser: not a connector of the user's.
    if (!m.ids.length || (loose && m.tier < 2)) {
      if (loose) return null
      return answer(`I don’t have a connector called ${quote(name)}.`)
    }
    return this.pick(
      m.ids,
      list,
      (id) => {
        const c = list.find((x) => x.id === id)!
        if (c.transport !== 'http')
          return answer(`${c.name} runs on this PC and doesn’t need a sign-in.`)
        void this.d.connectors.signIn(id).then(
          (r) =>
            this.d.connectors.notify(
              r.ok
                ? `Signed in to ${c.name}.`
                : `The ${c.name} sign-in didn’t finish: ${cut(r.error ?? '', 160)}`
            ),
          () => this.d.connectors.notify(`The ${c.name} sign-in didn’t finish.`)
        )
        return answer(`Opening the ${c.name} sign-in page in your browser.`)
      },
      'connector'
    )
  }

  // ---- guides ----

  private guidesList(): ManageAnswer {
    const list = this.d.guides.list()
    if (!list.length) return answer('You have no saved guides. Say “save this guide” after one.')
    return answer(
      `Your saved guides:\n${list.map((g) => `- ${g.name}`).join('\n')}`,
      `You have ${list.length === 1 ? 'one saved guide' : `${list.length} saved guides`}: ${someOf(list.map((g) => g.name))}.`
    )
  }

  private guideDelete(name: string): ManageReply {
    const list = this.d.guides.list()
    const m = matchNamed(name, list, GUIDE_NOISE)
    if (!m.ids.length)
      return answer(
        list.length
          ? `I don’t have a guide called ${quote(name)}. Ask “list my guides” to hear them.`
          : 'You have no saved guides.'
      )
    return this.pick(
      m.ids,
      list,
      (id) => {
        const g = list.find((x) => x.id === id)!
        return this.d.confirm(`Delete the saved guide ${quote(g.name)}?`, 'medium').then((yes) => {
          if (!yes) return answer(`Okay, I kept ${quote(g.name)}.`)
          return this.d.guides.remove(id)
            ? answer(`Deleted the guide ${quote(g.name)}.`)
            : answer('That guide is gone.')
        })
      },
      'guide'
    )
  }

  // ---- diagnostics ----

  private diagnosticsExport(): ManageReply {
    return this.d.diagnostics.export().then((r) => {
      if (!r.ok || !r.path) return answer(r.error ?? 'I couldn’t write the diagnostics file.')
      const file = r.path.split(/[\\/]/).pop() ?? r.path
      return answer(
        `Saved a diagnostics file to your Downloads folder as ${file}. It has logs and settings without your keys; nothing was sent.`,
        'Saved a diagnostics file to your Downloads folder. It has logs and settings without your keys; nothing was sent.'
      )
    })
  }
}
