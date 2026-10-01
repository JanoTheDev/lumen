// Session manager (08 T33/T36): several Claude Code sessions at once (one per project at most),
// open / resume / send / interrupt / stop, turn ends → autopilot answers or relays Claude's
// question, done and needs-you notices. Electron-free: everything outside is injected.
import { basename } from 'path'
import type {
  AutopilotLevel,
  ClaudeAutoAnswer,
  ClaudeCodeSettings,
  ClaudeProject,
  ClaudeSessionView
} from '@shared/claude-code'
import type { AuditEntry } from '../audit/log'
import { hashText } from '../audit/log'
import {
  autoAnswerLines,
  correctionTurn,
  detectQuestion,
  shouldAutoAnswer,
  type AutopilotDecision,
  type DecisionInput
} from './autopilot'
import { discoverCommands, matchCommand } from './commands'
import { oneLine } from './events'
import { samePath } from './projects'
import { ClaudeSession, type SessionDeps, type TurnEnd } from './session'
import type { SavedSession } from './store'

/** Auto-answers in a row before the next question goes to the user anyway. */
export const MAX_AUTO_STREAK = 5
const RECENT_USER = 8

export type NoticeKind = 'done' | 'needs-you' | 'info'

export interface CopilotDeps {
  settings(): ClaudeCodeSettings
  cliPath(): Promise<string | null>
  projects(): ClaudeProject[]
  spawn: SessionDeps['spawn']
  /** http://127.0.0.1:<port> of the hook server, or null when it is not running. */
  hookBase(): string | null
  /** Writes the per-session --settings file; returns its path. */
  writeSettings(key: string, base: string): string
  removeSettings(key: string): void
  decide(input: DecisionInput, signal?: AbortSignal): Promise<AutopilotDecision>
  claudeMd(project: string): string | undefined
  notify(text: string, kind: NoticeKind, session: ClaudeSessionView): void
  audit(entry: AuditEntry): void
  saved(): SavedSession[]
  remember(s: SavedSession): void
  changed(view: ClaudeSessionView): void
  now(): number
  newId(): string
  log(msg: string): void
}

interface Entry {
  s: ClaudeSession
  recentUser: string[]
  streak: number
  /** The last auto-answer while it can still be taken back. */
  lastAuto?: ClaudeAutoAnswer & { question: string }
}

export class ClaudeCopilot {
  private entries = new Map<string, Entry>()
  private focusedId: string | null = null

  constructor(private readonly deps: CopilotDeps) {}

  list(): ClaudeSessionView[] {
    return [...this.entries.values()]
      .map((e) => e.s.view)
      .sort((a, b) => b.lastActive - a.lastActive)
  }

  get(id: string): ClaudeSessionView | null {
    return this.entries.get(id)?.s.view ?? null
  }

  /** The session voice follow-ups go to: the one last opened or spoken to. */
  focused(): ClaudeSessionView | null {
    const f = this.focusedId ? this.entries.get(this.focusedId) : undefined
    return f?.s.view ?? this.list()[0] ?? null
  }

  focus(id: string): void {
    if (this.entries.has(id)) this.focusedId = id
  }

  forProject(project: string): ClaudeSessionView | null {
    return this.list().find((v) => samePath(v.project, project)) ?? null
  }

  levelFor(project: string): AutopilotLevel {
    const p = this.deps.projects().find((x) => samePath(x.path, project))
    return p?.autopilot ?? this.deps.settings().autopilot
  }

  /**
   * A session for the project: the running one, else a resumed one (the last CLI session for
   * this project) or a new one. `prompt` is the first turn.
   */
  async open(
    project: ClaudeProject,
    opts: { prompt?: string; resume?: boolean } = {}
  ): Promise<ClaudeSessionView> {
    const running = this.forProject(project.path)
    if (running) {
      this.focusedId = running.id
      if (opts.prompt) this.send(running.id, opts.prompt)
      return this.get(running.id)!
    }
    const cli = await this.deps.cliPath()
    if (!cli) throw new Error('Claude Code is not installed (no `claude` found).')
    const base = this.deps.hookBase()
    const id = this.deps.newId()
    const cfg = this.deps.settings()
    const last =
      opts.resume !== false
        ? this.deps.saved().find((s) => samePath(s.project, project.path))
        : undefined
    const settingsPath = base ? this.deps.writeSettings(id, base) : undefined
    if (!base) this.deps.log('hook server down: permission prompts will be denied by the CLI')
    const s = new ClaudeSession(
      {
        id,
        project: project.path,
        projectName: project.name,
        cliPath: cli,
        autopilot: this.levelFor(project.path),
        args: {
          ...(cfg.model ? { model: cfg.model } : {}),
          allowedTools: [...cfg.allowedTools, ...(project.allowedTools ?? [])],
          ...(settingsPath ? { settingsPath } : {})
        },
        ...(last ? { resume: last.sessionId, title: last.title } : {}),
        title: last?.title ?? project.name
      },
      { spawn: this.deps.spawn, now: this.deps.now, log: this.deps.log }
    )
    const entry: Entry = { s, recentUser: [], streak: 0 }
    this.entries.set(id, entry)
    this.focusedId = id
    s.on('change', (v: ClaudeSessionView) => {
      if (v.sessionId)
        this.deps.remember({
          project: v.project,
          sessionId: v.sessionId,
          title: v.title,
          lastActive: v.lastActive
        })
      this.deps.changed(v)
    })
    s.on('turn', (t: TurnEnd) => void this.onTurn(entry, t))
    s.on('exit', () => {
      if (s.view.phase === 'failed')
        this.deps.notify(`Claude Code stopped in ${s.view.projectName}.`, 'needs-you', s.view)
    })
    this.deps.changed(s.view)
    if (opts.prompt) this.send(id, opts.prompt)
    return s.view
  }

  /** A user turn ("tell Claude to …"). A spoken command name becomes its slash command. */
  send(id: string, text: string): ClaudeSessionView {
    const e = this.entries.get(id)
    if (!e) throw new Error('No such Claude session.')
    const turn = this.asCommand(e, text)
    e.recentUser = [...e.recentUser, text].slice(-RECENT_USER)
    e.streak = 0
    e.lastAuto = undefined
    this.focusedId = id
    if (e.s.view.title === e.s.view.projectName)
      e.s.update({ title: `${e.s.view.projectName}: ${oneLine(text, 50)}` })
    e.s.send(turn)
    return e.s.view
  }

  private asCommand(e: Entry, text: string): string {
    const t = text.trim()
    if (t.startsWith('/')) return t
    const m = /^(?:run|do|use|start)\s+(.+)$/i.exec(t)
    if (!m) return t
    const cmd = matchCommand(m[1], discoverCommands(e.s.view.project, e.s.view.commands))
    return cmd ? `/${cmd.name}` : t
  }

  async interrupt(id: string): Promise<boolean> {
    const e = this.entries.get(id)
    if (!e) return false
    await e.s.interrupt()
    return true
  }

  stop(id: string): boolean {
    const e = this.entries.get(id)
    if (!e) return false
    e.s.stop()
    return true
  }

  /** Closes the session's process and forgets it in the list (it stays resumable). */
  close(id: string): boolean {
    const e = this.entries.get(id)
    if (!e) return false
    e.s.stop()
    this.deps.removeSettings(id)
    this.entries.delete(id)
    if (this.focusedId === id) this.focusedId = null
    return true
  }

  setAutopilot(level: AutopilotLevel, id?: string): void {
    const targets = id ? [this.entries.get(id)].filter(Boolean) : [...this.entries.values()]
    for (const e of targets as Entry[]) e.s.update({ autopilot: level })
  }

  /** "undo that answer": a correction turn while Claude is still on it. */
  undoAnswer(id: string): boolean {
    const e = this.entries.get(id)
    const last = e?.lastAuto
    if (!e || !last) return false
    e.lastAuto = undefined
    // The user took over: the next question goes to them, not to autopilot.
    e.streak = MAX_AUTO_STREAK
    e.s.send(correctionTurn(last.answer, last.question))
    this.audit(e, 'claude_answer_undo', last.question, 'confirmed-by-user')
    return true
  }

  /** The user answers Claude's relayed question. */
  answerQuestion(id: string, text: string): boolean {
    const e = this.entries.get(id)
    if (!e || e.s.view.pending?.kind !== 'question') return false
    this.send(id, text)
    return true
  }

  /** Called by the permission bridge while a prompt waits. */
  setPending(id: string, pending: ClaudeSessionView['pending'] | null): void {
    const e = this.entries.get(id)
    if (!e) return
    if (pending) e.s.update({ pending, phase: 'waiting-permission' })
    else if (e.s.view.pending?.kind === 'permission')
      e.s.update({ pending: undefined, phase: e.s.alive ? 'running-tool' : e.s.view.phase })
  }

  shutdown(): void {
    for (const e of this.entries.values()) e.s.stop()
  }

  // ---- turn ends ----

  private async onTurn(e: Entry, t: TurnEnd): Promise<void> {
    const v = e.s.view
    if (t.interrupted) return
    if (t.isError) {
      this.deps.notify(`Claude hit a problem in ${v.projectName}.`, 'needs-you', v)
      return
    }
    const q = detectQuestion(t.text)
    if (!q) {
      e.streak = 0
      this.deps.notify(`Claude finished in ${v.projectName}: ${oneLine(t.text, 120)}`, 'done', v)
      return
    }
    const level = v.autopilot
    if (level !== 'off' && e.streak < MAX_AUTO_STREAK) {
      try {
        const d = await this.deps.decide({
          question: q,
          claudeMd: this.deps.claudeMd(v.project),
          notes: this.deps.projects().find((p) => samePath(p.path, v.project))?.notes,
          recent: e.recentUser
        })
        if (shouldAutoAnswer(level, d, this.deps.settings().confidence)) {
          const a: ClaudeAutoAnswer = {
            question: oneLine(q.question, 300),
            answer: d.answer.trim(),
            reason: d.reason,
            at: this.deps.now()
          }
          e.streak++
          e.lastAuto = { ...a, question: q.question }
          e.s.update({ autoAnswers: [...v.autoAnswers, a].slice(-20) })
          e.s.send(a.answer)
          this.audit(e, 'claude_answer', q.question, 'auto', d.reason)
          this.deps.notify(
            `${autoAnswerLines([a])[0]}. Say “undo that answer” to take it back.`,
            'info',
            e.s.view
          )
          return
        }
      } catch (err) {
        this.deps.log(`autopilot decision failed: ${(err as Error).message}`)
      }
    }
    e.s.update({
      phase: 'waiting-answer',
      pending: { kind: 'question', text: oneLine(q.question, 600) }
    })
    this.deps.notify(
      `Claude asks in ${v.projectName}: ${oneLine(q.question, 200)}`,
      'needs-you',
      e.s.view
    )
  }

  private audit(
    e: Entry,
    type: string,
    question: string,
    decision: AuditEntry['decision'],
    reason?: string
  ): void {
    this.deps.audit({
      t: new Date(this.deps.now()).toISOString(),
      task: `claude-code:${e.s.view.id}`,
      origin: 'claude-code',
      action: { type, project: basename(e.s.view.project), question: hashText(question) },
      risk: 'low',
      decision,
      result: 'ok',
      ms: 0,
      ...(reason ? { reason: reason.slice(0, 300) } : {})
    })
  }
}

/** "What's Claude doing?" in one line. */
export function statusLine(v: ClaudeSessionView | null): string {
  if (!v) return 'No Claude session is open. Say “open <project> in Claude”.'
  const where = `Claude in ${v.projectName}`
  if (v.pending?.kind === 'permission')
    return `${where} is waiting for your OK: ${oneLine(v.pending.command ?? v.pending.text, 140)}`
  if (v.pending?.kind === 'question') return `${where} asks: ${oneLine(v.pending.text, 160)}`
  const cost = v.costUsd ? ` (so far $${v.costUsd.toFixed(2)})` : ''
  switch (v.phase) {
    case 'starting':
      return `${where} is starting.`
    case 'thinking':
      return `${where} is thinking.${cost}`
    case 'running-tool':
      return `${where}: ${v.lastLine}.${cost}`
    case 'failed':
      return `${where} stopped with an error${v.error ? `: ${v.error}` : ''}.`
    case 'stopped':
      return `${where} is stopped. Tell it something to resume.`
    default:
      return `${where} is done${v.lastLine ? `: ${v.lastLine}` : ''}.${cost}`
  }
}
