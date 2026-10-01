// Claude Code copilot (08 T33–T40): types shared by main and the Settings section, and the
// validators for its IPC payloads. Lumen drives the user's own `claude` CLI headless.
import { z } from 'zod'

export const AUTOPILOT_LEVELS = ['off', 'careful', 'full'] as const
export type AutopilotLevel = (typeof AUTOPILOT_LEVELS)[number]

export type ClaudePhase =
  | 'starting'
  | 'thinking'
  | 'running-tool'
  | 'waiting-permission'
  | 'waiting-answer'
  | 'idle'
  | 'stopped'
  | 'failed'

export interface ClaudeAutoAnswer {
  question: string
  answer: string
  reason: string
  at: number
}

export interface ClaudeSessionView {
  /** Lumen's id for the session (cc_…). */
  id: string
  project: string
  projectName: string
  /** The CLI's session id, known after the first init event. */
  sessionId?: string
  title: string
  phase: ClaudePhase
  /** One line of what Claude is doing now. */
  lastLine: string
  /** The last turn's final text. */
  lastAnswer?: string
  costUsd: number
  turns: number
  startedAt: number
  lastActive: number
  autopilot: AutopilotLevel
  /** A permission or a question waiting for the user. */
  pending?: { kind: 'permission' | 'question'; text: string; command?: string }
  autoAnswers: ClaudeAutoAnswer[]
  /** Commands from the session's init event. */
  commands: string[]
  error?: string
}

export interface ClaudeProject {
  path: string
  name: string
  source: 'claude' | 'user'
  lastActive?: number
  autopilot?: AutopilotLevel
  allowedTools?: string[]
  notes?: string
}

export interface ClaudeCliStatus {
  found: boolean
  path?: string
  version?: string
  installUrl: string
}

export interface ClaudeHooksPreview {
  path: string
  installed: boolean
  /** Unified-style line diff of ~/.claude/settings.json (+ / - lines). */
  diff: string
  /** Hash of the file as read; install/uninstall only write when it still matches. */
  hash: string
  /** Lumen's hook server is not on the port the installed hooks use (re-install). */
  stale?: boolean
}

export const claudeProjectEntrySchema = z.object({
  path: z.string().min(1).max(1024),
  name: z.string().max(120).optional(),
  autopilot: z.enum(AUTOPILOT_LEVELS).optional(),
  allowedTools: z.array(z.string().min(1).max(200)).max(100).optional(),
  notes: z.string().max(2000).optional()
})

export type ClaudeProjectEntry = z.infer<typeof claudeProjectEntrySchema>

export const claudeCodeSettingsSchema = z.object({
  /** Empty: found on PATH or in the usual install folders. */
  cliPath: z.string().max(1024),
  autopilot: z.enum(AUTOPILOT_LEVELS),
  /** Passed as --allowedTools (CLI rule syntax, e.g. "Bash(npm test *)"). */
  allowedTools: z.array(z.string().min(1).max(200)).max(100),
  /** Folders the user added, plus per-project overrides. */
  projects: z.array(claudeProjectEntrySchema).max(200),
  /** Global hooks in ~/.claude/settings.json for sessions started by hand (opt-in). */
  hooksObserver: z.boolean(),
  /** --model for new sessions; empty = the user's own default. */
  model: z.string().max(80),
  /** Autopilot answers only at or above this confidence. */
  confidence: z.number().min(0.5).max(1)
})

export type ClaudeCodeSettings = z.infer<typeof claudeCodeSettingsSchema>

export const CLAUDE_CODE_DEFAULTS: ClaudeCodeSettings = {
  cliPath: '',
  autopilot: 'careful',
  allowedTools: [],
  projects: [],
  hooksObserver: false,
  model: '',
  confidence: 0.8
}

export const claudeSettingsPatchSchema = claudeCodeSettingsSchema
  .omit({ hooksObserver: true })
  .partial()
  .strict()
export type ClaudeSettingsPatch = z.infer<typeof claudeSettingsPatchSchema>

export const claudeOpenSchema = z.object({
  project: z.string().min(1).max(1024),
  prompt: z.string().max(20_000).optional(),
  resume: z.boolean().optional()
})

export const claudeSendSchema = z.object({
  id: z.string().regex(/^cc_[a-z0-9]{4,40}$/),
  text: z.string().min(1).max(20_000)
})

export const claudeIdSchema = z.string().regex(/^cc_[a-z0-9]{4,40}$/)

export const claudePermissionAnswerSchema = z.object({
  id: z.string().min(1).max(80),
  answer: z.enum(['once', 'always', 'deny'])
})

export const claudeHooksWriteSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) })

export const claudePathSchema = z.string().min(1).max(1024)
