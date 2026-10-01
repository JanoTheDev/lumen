// Connectors (MCP servers) as Settings sees them. Pure TS: secrets (bearer token, env
// values) never cross IPC back to a renderer; only whether they are set.

export type ConnectorTransport = 'stdio' | 'http'
export type ToolPolicy = 'ask' | 'allow' | 'deny'

/** One server as stored in ~/.ai-overlay/connectors.json (no secrets). */
export interface ConnectorServer {
  /** Lowercase letters, digits and dashes; part of the tool names the model sees. */
  id: string
  name: string
  transport: ConnectorTransport
  /** stdio */
  command?: string
  args?: string[]
  /** Names of the environment variables passed to the command; values are encrypted. */
  envNames?: string[]
  /** http(s) endpoint (http only for localhost). */
  url?: string
  enabled: boolean
  /** The user ticked "I trust this command" for exactly this command line. */
  trusted?: boolean
  toolPolicy: Record<string, ToolPolicy>
}

/** A server for the Settings list: the stored fields plus secret and connection state. */
export interface ConnectorView extends ConnectorServer {
  hasBearer: boolean
  /** The exact command line that runs (stdio). */
  commandLine?: string
  state: 'off' | 'idle' | 'connected' | 'error'
  error?: string
  toolCount?: number
}

/** Add or update request. Secrets are write-only: omitted = keep, '' = remove. */
export interface ConnectorInput {
  id: string
  name: string
  transport: ConnectorTransport
  command?: string
  args?: string[]
  url?: string
  enabled?: boolean
  /** Required (true) for stdio servers whose command line is new or changed. */
  trustCommand?: boolean
  bearer?: string
  /** Variable name → value; a value of '' removes that variable. */
  env?: Record<string, string>
  toolPolicy?: Record<string, ToolPolicy>
}

export interface ConnectorToolInfo {
  name: string
  description: string
  readOnly: boolean
  destructive: boolean
  policy: ToolPolicy | 'default'
}

export type ConnectorResult = { ok: true } | { ok: false; error: string }

export type ConnectorTestResult = { ok: true; toolCount: number } | { ok: false; error: string }

/** The command line as it runs, quoted where needed (shown before the user trusts it). */
export function commandLine(command: string | undefined, args: readonly string[] = []): string {
  const q = (s: string): string => (/[\s"]/.test(s) || !s ? `"${s.replace(/"/g, '\\"')}"` : s)
  return [command ?? '', ...args].map(q).join(' ')
}
