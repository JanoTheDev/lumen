// Claude Code plugin import (plugins:*) as Settings sees it. Pure TS.

/** Where to import from. */
export type PluginSource =
  | { kind: 'github'; url: string }
  /** Main shows a folder picker. */
  | { kind: 'folder' }
  /** The user's own Claude Code setup in ~/.claude (skills, commands, output styles, plugins). */
  | { kind: 'claude-home' }

/** One Lumen skill an import would install. */
export interface PluginSkillPreview {
  name: string
  description: string
  /** What it was in Claude Code. */
  from: 'skill' | 'command' | 'output-style'
  /** Plugin (or "your Claude Code skills") it came from. */
  plugin: string
  kind: 'task' | 'style'
  triggers: string[]
  /** Replaces an earlier import of the same skill. */
  updates: boolean
  /** It was trusted, and the new content resets that. */
  resetsTrust?: boolean
  /** Fields or parts Lumen leaves out or changes, in plain words. */
  notes: string[]
}

/** One MCP server from a plugin's .mcp.json, offered as a connector. */
export interface PluginConnectorPreview {
  /** Stable key for the import request. */
  key: string
  name: string
  /** Connector id it would get. */
  id: string
  plugin: string
  transport: 'stdio' | 'http'
  /** stdio: the exact command line that would run. */
  commandLine?: string
  url?: string
  /** Environment variables the user must fill in Settings → Connectors afterwards. */
  envNeeded: string[]
  /** http: needs an access token pasted afterwards. */
  tokenNeeded: boolean
  /** A connector with this id exists: same command (kept as is) or different (updated). */
  exists?: 'same' | 'different'
  notes: string[]
}

/** Something in the source that is not imported, and why. */
export interface PluginSkipped {
  what: string
  why: string
}

export type PluginPreviewResult =
  | {
      ok: true
      token: string
      source: string
      plugins: { name: string; version?: string; description?: string }[]
      skills: PluginSkillPreview[]
      connectors: PluginConnectorPreview[]
      skipped: PluginSkipped[]
    }
  | { ok: false; error: string; problems?: string[] }

export interface PluginImportRequest {
  token: string
  /** Keys of the connectors the user ticked "I trust this command / server" for. */
  connectors: string[]
}

export type PluginImportResult =
  | {
      ok: true
      skills: { name: string; updated: boolean }[]
      connectors: { id: string; ok: boolean; error?: string }[]
    }
  | { ok: false; error: string; problems?: string[] }

/** What the user's ~/.claude holds, for the "Import my Claude Code skills" offer. */
export interface ClaudeHomeScan {
  found: boolean
  skills: number
  commands: number
  outputStyles: number
  plugins: number
}
