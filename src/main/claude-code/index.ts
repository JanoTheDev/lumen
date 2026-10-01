// Claude Code copilot wiring (08 T33–T40): the copilot singleton with the real CLI spawn, the
// fast-model autopilot decision, the hook server + permission bridge on the bar's confirm card,
// presence-gated notices, the opt-in global hooks, and the voice interceptor.
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { powerMonitor } from 'electron'
import type { ClaudeProject, ClaudeSessionView } from '@shared/claude-code'
import { getProvider } from '../ai/providers'
import { parseJsonAs } from '../ai/json'
import { announce } from '../a11y'
import { writeAudit } from '../audit/log'
import { configPath, loadConfig } from '../config'
import { log } from '../logger'
import * as assistant from '../windows/assistant'
import { noticeVerdict, PRESENT_MS } from '../agent-mode/background/presence'
import { isOpen } from '../agent-mode/background/manager'
import { backgroundManager, startBackgroundTask } from '../agent-mode/background'
import { memory } from '../ai/memory/runtime'
import { bus } from '../bus'
import { DECISION_SYSTEM, decisionPrompt, decisionSchema, profileForDecision } from './autopilot'
import { barView, pushLine, runClaudeTurn, sessionBusy, taskTitleFor } from './background'
import { PermissionBridge, permissionSummary, type PendingPermission } from './bridge'
import { findClaude } from './cli'
import { ClaudeCopilot, statusLine, type NoticeKind } from './copilot'
import { HookServer, type HookCall } from './hook-server'
import { withTreeKill } from './kill-tree'
import { applyHooks, previewHooks, writeSessionSettings } from './hooks-config'
import { matchClaudeCodeIntent, type ClaudeIntent } from './intents'
import { listClaudeProjects, matchProject, mergeProjects } from './projects'
import { CopilotStore } from './store'
import { CodingSkillLibrary } from '../coding-skills/library'
import { CodingSkills } from '../coding-skills/service'
import { CodingSkillVoice } from '../coding-skills/voice'
import { authorSkill } from '../skills/compose'
import type { Complete } from '../web/summarize'
import * as settingsWindow from '../windows/settings'

let store: CopilotStore | null = null
let server: HookServer | null = null
let copilot: ClaudeCopilot | null = null
let bridge: PermissionBridge | null = null
let listeners: ((v: ClaudeSessionView) => void)[] = []

function idleMs(): number {
  try {
    return powerMonitor.getSystemIdleTime() * 1000
  } catch {
    return 0
  }
}

function present(): boolean {
  return idleMs() < PRESENT_MS
}

function notify(text: string, kind: NoticeKind): void {
  const v = noticeVerdict({
    idleMs: idleMs(),
    quiet: loadConfig().agent.background.quiet,
    midTurn: assistant.confirmPending()
  })
  log('step', `[claude-code] ${text}`)
  if (v === 'list-only') return
  announce(text, { kind: 'status', priority: kind === 'needs-you' ? 'assertive' : 'polite' })
}

export function copilotStore(): CopilotStore {
  store ??= new CopilotStore(join(dirname(configPath()), 'claude-code'))
  return store
}

// ---- coding skills ----

let skills: CodingSkills | null = null
let skillVoice: CodingSkillVoice | null = null

const fastComplete: Complete = async (system, user, schema, maxTokens, signal) => {
  const { llm, model, effort } = getProvider('fast')
  const res = await llm.complete(
    {
      model,
      system: [{ text: system, cacheable: true }],
      messages: [{ role: 'user', content: user }],
      maxTokens,
      effort,
      schema,
      schemaName: 'coding_skill'
    },
    signal
  )
  return res.data ?? parseJsonAs(res.text, schema)
}

/** Coding skills (library, drafts, per-project attachments) for Lumen-started sessions. */
export function codingSkills(): CodingSkills {
  skills ??= new CodingSkills({
    library: new CodingSkillLibrary(join(copilotStore().dir, 'coding-skills')),
    distill: { complete: fastComplete },
    author: (req) => authorSkill(req),
    now: () => Date.now(),
    newId: () => `csd_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
    changed: (projects) => void copilot?.reloadSkills(projects),
    log: (m) => log('step', `[coding-skills] ${m}`)
  })
  return skills
}

/** The session's plugin folder (Lumen-owned, under run/): rebuilt at every spawn. */
function sessionPluginDir(key: string): string {
  return join(copilotStore().runDir, `${key}-skills`)
}

/** "Claude picks it up from its next turn." for projects with a running session. */
export function skillReloadNote(projects: string[]): string {
  const live = projects.some((p) => copilot?.forProject(p))
  return live
    ? 'Claude picks it up from its next turn.'
    : 'Claude loads it the next time it starts there.'
}

function voiceSkills(): CodingSkillVoice {
  skillVoice ??= new CodingSkillVoice({
    skills: codingSkills(),
    focusedProject: () => {
      const f = copilot?.focused()
      return f ? { path: f.project, name: f.projectName } : null
    },
    matchProject: (spoken) => {
      const p = matchProject(spoken, allProjects())
      return p ? { path: p.path, name: p.name } : null
    },
    reloadNote: skillReloadNote,
    notify: (text, urgent) => notify(text, urgent ? 'needs-you' : 'info'),
    showDraft: () => settingsWindow.create('settings/claude-code'),
    now: () => Date.now(),
    log: (m) => log('step', `[coding-skills] ${m}`)
  })
  return skillVoice
}

export function allProjects(): ClaudeProject[] {
  return mergeProjects(listClaudeProjects(), copilotStore().settings().projects)
}

function claudeMd(project: string): string | undefined {
  const f = join(project, 'CLAUDE.md')
  try {
    return existsSync(f) ? readFileSync(f, 'utf8').slice(0, 6000) : undefined
  } catch {
    return undefined
  }
}

// ---- permission cards: one at a time on the bar ----

let cardChain: Promise<unknown> = Promise.resolve()
let showing: PendingPermission | null = null
const answered = new Set<string>()

function askOnBar(p: PendingPermission): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    // Answered by voice (or the CLI hung up) while waiting for its turn on the bar.
    if (answered.delete(p.id)) return false
    showing = p
    try {
      return await assistant.requestConfirm({ summary: permissionSummary(p), risk: p.risk })
    } finally {
      showing = null
    }
  }
  const next = cardChain.then(run, run)
  cardChain = next.catch(() => undefined)
  return next
}

function dismissCard(p: PendingPermission): void {
  if (showing?.id === p.id) assistant.dropConfirm()
  else answered.add(p.id)
}

// ---- hooks ----

async function onHook(call: HookCall): Promise<Record<string, unknown>> {
  const c = copilot
  if (!c) return {}
  if (call.scope === 'session') {
    if (call.event === 'PermissionRequest' && call.sessionKey && bridge)
      return bridge.handle(call.sessionKey, call.payload, call.signal)
    return {}
  }
  // Global hooks: only sessions Lumen did not start (its own report through stream-json).
  const sid = call.payload.session_id
  if (c.list().some((v) => v.sessionId === sid)) return {}
  const st = copilotStore().settings()
  if (call.event === 'PermissionRequest') {
    // Opt-in (T38): answered on the bar / by voice, else Claude's own prompt after the wait.
    if (!bridge || !st.hooksObserver || !st.hooksPermissions) return {}
    return bridge.handleObserved(call.payload, call.signal, st.hooksPermissionWaitS * 1000)
  }
  const where = basename(String(call.payload.cwd ?? '')) || 'a project'
  if (call.event === 'Notification') {
    const msg = String(call.payload.message ?? '').slice(0, 200)
    notify(`Claude needs you in ${where}${msg ? `: ${msg}` : ''}.`, 'needs-you')
  } else if (call.event === 'Stop') notify(`Claude finished in ${where}.`, 'done')
  return {}
}

export function hookBase(): string | null {
  return server?.port ? `http://127.0.0.1:${server.port}` : null
}

function globalHookOptions(): { permissions: boolean; waitS: number } {
  const s = copilotStore().settings()
  return { permissions: s.hooksPermissions, waitS: s.hooksPermissionWaitS }
}

export function hooksPreview(install: boolean): ReturnType<typeof previewHooks> {
  const base = hookBase() ?? 'http://127.0.0.1:0'
  return previewHooks(
    install,
    base,
    copilotStore().hook().token,
    server?.port ?? 0,
    undefined,
    globalHookOptions()
  )
}

export function hooksApply(install: boolean, hash: string): { ok: boolean; error?: string } {
  const base = hookBase()
  if (install && !base) return { ok: false, error: 'Lumen’s hook endpoint is not running.' }
  const r = applyHooks(
    install,
    hash,
    base ?? '',
    copilotStore().hook().token,
    undefined,
    globalHookOptions()
  )
  if (r.ok) {
    const s = copilotStore().settings()
    copilotStore().saveSettings({ ...s, hooksObserver: install })
  }
  return r
}

// ---- install ----

export function onSessionChange(fn: (v: ClaudeSessionView) => void): () => void {
  listeners.push(fn)
  return () => (listeners = listeners.filter((l) => l !== fn))
}

export function getCopilot(): ClaudeCopilot | null {
  return copilot
}

export function getBridge(): PermissionBridge | null {
  return bridge
}

// ---- Tasks list + bar view (T39) ----

/** Lumen session id → its open background task. */
const sessionTasks = new Map<string, string>()
/** Recent activity lines per session (the bar's list). */
const recentLines = new Map<string, string[]>()

/** Memory profile facts for the autopilot decision (T36): profile layer only, redacted. */
function profileFacts(): string[] {
  try {
    const m = memory()
    return m.isEnabled() ? profileForDecision(m.profile.facts()) : []
  } catch {
    return []
  }
}

function sessionPort(id: string): Parameters<typeof runClaudeTurn>[1] {
  return {
    view: () => copilot?.get(id) ?? null,
    onChange: (fn) => onSessionChange((v) => v.id === id && fn(v)),
    answer: (text) => void copilot?.answerQuestion(id, text),
    permission: (answer, permId) => void bridge?.answer(answer, permId),
    interrupt: () => void copilot?.interrupt(id)
  }
}

/** A busy session without an open task gets one (one per stretch of work). */
function syncTask(v: ClaudeSessionView): void {
  if (!sessionBusy(v)) return
  const open = sessionTasks.get(v.id)
  const t = open ? backgroundManager().get(open) : null
  if (t && isOpen(t)) return
  const s = copilotStore().settings()
  const task = startBackgroundTask({
    prompt: v.title,
    title: taskTitleFor(v),
    origin: 'voice',
    claude: { id: v.id, projectName: v.projectName, phase: v.phase },
    run: (ctl) =>
      runClaudeTurn(ctl, sessionPort(v.id), {
        maxCostUsd: s.taskMaxCostUsd,
        maxWallMs: s.taskMaxMin * 60_000
      })
  })
  sessionTasks.set(v.id, task.id)
}

function syncBar(v: ClaudeSessionView): void {
  const lines = pushLine(recentLines.get(v.id) ?? [], v.lastLine)
  recentLines.set(v.id, lines)
  bus.emit({ type: 'claude.bar', view: barView(v, lines) })
}

/** Puts the session (default: the focused one) on the assistant bar. */
export function showSessionOnBar(id?: string): boolean {
  const c = copilot
  const v = id ? c?.get(id) : c?.focused()
  if (!c || !v) return false
  c.focus(v.id)
  bus.emit({ type: 'claude.bar', view: barView(v, recentLines.get(v.id) ?? []), show: true })
  return true
}

/** The Claude session behind a Tasks-list row, if it is one. */
export function sessionForTask(taskId: string): string | null {
  const t = backgroundManager().get(taskId)
  return t?.claude && copilot?.get(t.claude.id) ? t.claude.id : null
}

// ---- dictation (04 T42) ----

/** Folder of the session dictation would go to (the focused one). */
export function focusedProject(): string | undefined {
  return copilot?.focused()?.project
}

/** The known project whose folder name is in a window title ("x.ts - lumen - Visual Studio Code"). */
export function projectForTitle(title: string): string | undefined {
  const t = title.toLowerCase()
  let best: ClaudeProject | undefined
  for (const p of allProjects()) {
    const name = basename(p.path).toLowerCase()
    if (name.length < 3) continue
    const at = t.indexOf(name)
    if (
      at < 0 ||
      /[\p{L}\p{N}]/u.test(t[at - 1] ?? '') ||
      /[\p{L}\p{N}]/u.test(t[at + name.length] ?? '')
    )
      continue
    if (!best || name.length > basename(best.path).length) best = p
  }
  return best?.path
}

/** Dictated text to the focused session, the same way "tell Claude …" goes. */
export function sendDictation(text: string): { ok: boolean; notice: string } {
  const c = copilot
  const f = c?.focused()
  if (!c || !f)
    return { ok: false, notice: 'No Claude session is open. Say “open <project> in Claude”.' }
  if (f.pending?.kind === 'question') c.answerQuestion(f.id, text)
  else c.send(f.id, text)
  return { ok: true, notice: `Sent to Claude in ${f.projectName}.` }
}

/** Starts the hook endpoint and the copilot (no CLI process starts until a session opens). */
export async function installClaudeCode(): Promise<void> {
  if (copilot) return
  const st = copilotStore()
  const { token, port } = st.hook()
  rmSync(st.runDir, { recursive: true, force: true })
  server = new HookServer(token, onHook, (m) => log('fail', `[claude-code] ${m}`))
  try {
    st.savePort(await server.start(port))
  } catch (e) {
    log('fail', `[claude-code] hook server: ${(e as Error).message}`)
    server = null
  }
  copilot = new ClaudeCopilot({
    settings: () => st.settings(),
    cliPath: () => findClaude(st.settings().cliPath),
    projects: allProjects,
    spawn: (cmd, cwd, env) =>
      withTreeKill(
        spawn(cmd.file, cmd.args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: cmd.verbatim
        })
      ),
    hookBase,
    writeSettings: (key, base) => writeSessionSettings(st.runDir, base, key, token),
    removeSettings: (key) => {
      rmSync(join(st.runDir, `${key}.json`), { force: true })
      rmSync(sessionPluginDir(key), { recursive: true, force: true })
    },
    pluginDirs: (key, project) => {
      try {
        const dir = codingSkills().library.buildPluginDir(sessionPluginDir(key), project)
        return dir ? [dir] : []
      } catch (e) {
        log('fail', `[coding-skills] plugin folder: ${(e as Error).message}`)
        return []
      }
    },
    decide: async (input, signal) => {
      const { llm, model, effort } = getProvider('fast')
      const res = await llm.complete(
        {
          model,
          system: [{ text: DECISION_SYSTEM, cacheable: true }],
          messages: [{ role: 'user', content: decisionPrompt(input) }],
          maxTokens: 400,
          effort,
          schema: decisionSchema,
          schemaName: 'claude_code_answer'
        },
        signal
      )
      const d = res.data ?? parseJsonAs(res.text, decisionSchema)
      if (!d) throw new Error('decision did not match the schema')
      return d
    },
    claudeMd,
    profile: profileFacts,
    notify: (text, kind) => notify(text, kind),
    audit: writeAudit,
    saved: () => st.sessions(),
    remember: (s) => st.remember(s),
    changed: (v) => {
      listeners.forEach((l) => l(v))
      syncTask(v)
      syncBar(v)
    },
    now: () => Date.now(),
    newId: () => `cc_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
    log: (m) => log('step', `[claude-code] ${m}`)
  })
  const c = copilot
  bridge = new PermissionBridge({
    session: (key) => {
      const v = c.get(key)
      return v ? { project: v.project, projectName: v.projectName, level: v.autopilot } : null
    },
    ask: (p) => {
      notify(`Claude needs your OK in ${p.projectName}.`, 'needs-you')
      return askOnBar(p)
    },
    dismiss: dismissCard,
    present,
    onPending: (key, p) =>
      c.setPending(
        key,
        p ? { kind: 'permission', text: permissionSummary(p), command: p.what, permId: p.id } : null
      ),
    audit: writeAudit,
    now: () => Date.now()
  })
}

export function shutdownClaudeCode(): void {
  copilot?.shutdown()
  server?.stop()
}

// ---- voice ----

function spokenAnswer(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700)
}

function reply(text: string): { mode: 'answer'; text: string; spoken: string } {
  return { mode: 'answer', text, spoken: text }
}

function handle(i: ClaudeIntent): ReturnType<typeof reply> | undefined {
  const c = copilot
  if (!c) return undefined
  const f = c.focused()
  switch (i.kind) {
    case 'open': {
      const p = matchProject(i.project, allProjects())
      if (!p)
        return reply(
          `I don’t know a project called “${i.project}”. Add its folder in Settings → Claude Code.`
        )
      c.open(p, { prompt: i.prompt }).then(
        (v) => showSessionOnBar(v.id),
        (e: Error) => notify(e.message, 'needs-you')
      )
      return reply(`Opening Claude in ${p.name}.`)
    }
    case 'tell': {
      if (!f) return reply('No Claude session is open. Say “open <project> in Claude”.')
      if (f.pending?.kind === 'question') c.answerQuestion(f.id, i.text)
      else c.send(f.id, i.text)
      return reply(`Sent to Claude in ${f.projectName}.`)
    }
    case 'status':
      if (f) showSessionOnBar(f.id)
      return reply(statusLine(f))
    case 'read-last':
      return reply(f?.lastAnswer ? spokenAnswer(f.lastAnswer) : 'Claude has not answered yet.')
    case 'permission': {
      if (!bridge?.list().length) return undefined
      bridge.answer(i.answer)
      return reply(
        i.answer === 'deny'
          ? 'Denied.'
          : i.answer === 'always'
            ? 'Allowed for this session.'
            : 'Approved.'
      )
    }
    case 'answer':
      if (!f || f.pending?.kind !== 'question') return undefined
      c.answerQuestion(f.id, i.text)
      return reply('Sent your answer to Claude.')
    case 'stop':
      if (!f) return reply('No Claude session is running.')
      void c.interrupt(f.id)
      return reply(`Stopping Claude in ${f.projectName}.`)
    case 'autopilot': {
      if (f) c.setAutopilot(i.level, f.id)
      else copilotStore().saveSettings({ ...copilotStore().settings(), autopilot: i.level })
      return reply(`Autopilot ${i.level}${f ? ` for ${f.projectName}` : ''}.`)
    }
    case 'undo-answer':
      if (!f || !c.undoAnswer(f.id)) return undefined
      return reply('Told Claude to disregard my answer and wait for you.')
  }
}

/** Router stage hook: a Claude Code voice intent → handled reply, else undefined. */
export function interceptClaudeCode(prompt: string): unknown | undefined {
  const skill = copilot ? voiceSkills().intercept(prompt) : undefined
  if (skill) return skill
  const i = matchClaudeCodeIntent(prompt)
  if (!i) return undefined
  try {
    return handle(i)
  } catch (e) {
    return reply((e as Error).message)
  }
}
