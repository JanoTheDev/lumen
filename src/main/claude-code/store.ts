// Files of the Claude Code copilot under ~/.ai-overlay/claude-code/: settings.json (its own file,
// validated, defaults on error), hook.json (per-install token + the port global hooks use),
// sessions.json (project, CLI session id, title, last active: "resume last"), run/ (per-session
// --settings files).
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import {
  CLAUDE_CODE_DEFAULTS,
  claudeCodeSettingsSchema,
  type ClaudeCodeSettings
} from '@shared/claude-code'

export interface SavedSession {
  project: string
  sessionId: string
  title: string
  lastActive: number
}

const savedSchema = z.array(
  z.object({
    project: z.string().min(1).max(1024),
    sessionId: z.string().regex(/^[\w-]{8,80}$/),
    title: z.string().max(200),
    lastActive: z.number()
  })
)
const hookSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  port: z.number().int().min(0).max(65535)
})

const MAX_SAVED = 100

function readJson(file: string): unknown {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined
  } catch {
    return undefined
  }
}

function writeJson(file: string, v: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export class CopilotStore {
  constructor(readonly dir: string) {}

  get runDir(): string {
    return join(this.dir, 'run')
  }

  private ensure(): void {
    mkdirSync(this.dir, { recursive: true })
  }

  settings(): ClaudeCodeSettings {
    const raw = readJson(join(this.dir, 'settings.json'))
    const r = claudeCodeSettingsSchema.safeParse({ ...CLAUDE_CODE_DEFAULTS, ...(raw as object) })
    return r.success ? r.data : { ...CLAUDE_CODE_DEFAULTS }
  }

  saveSettings(next: ClaudeCodeSettings): ClaudeCodeSettings {
    const v = claudeCodeSettingsSchema.parse(next)
    this.ensure()
    writeJson(join(this.dir, 'settings.json'), v)
    return v
  }

  /** The per-install token (created once) and the last hook port. */
  hook(): { token: string; port: number } {
    const r = hookSchema.safeParse(readJson(join(this.dir, 'hook.json')))
    if (r.success) return r.data
    const fresh = { token: randomBytes(32).toString('hex'), port: 0 }
    this.ensure()
    writeJson(join(this.dir, 'hook.json'), fresh)
    return fresh
  }

  savePort(port: number): void {
    const h = this.hook()
    if (h.port === port) return
    writeJson(join(this.dir, 'hook.json'), { ...h, port })
  }

  sessions(): SavedSession[] {
    const r = savedSchema.safeParse(readJson(join(this.dir, 'sessions.json')))
    return r.success ? r.data : []
  }

  remember(s: SavedSession): void {
    const list = [s, ...this.sessions().filter((x) => x.sessionId !== s.sessionId)]
      .sort((a, b) => b.lastActive - a.lastActive)
      .slice(0, MAX_SAVED)
    this.ensure()
    writeJson(join(this.dir, 'sessions.json'), list)
  }
}
