// Pure helpers of the integrations catalog in Settings → Connectors (tested without a DOM).
import { CONNECTOR_CATALOG, catalogArgs, type CatalogEntry } from '@shared/connector-catalog'
import { commandLine, type ConnectorInput, type ConnectorView } from '@shared/connectors'
import { idFromName, parseArgs } from './connectors-form'

/** A catalog entry already added: same address, same program and package, or same id. */
export function isAdded(e: CatalogEntry, list: readonly ConnectorView[]): boolean {
  return list.some((c) =>
    e.kind === 'remote'
      ? c.transport === 'http' && c.url === e.url
      : c.transport === 'stdio' &&
        c.command === e.command &&
        (e.args ?? []).every((a, i) => c.args?.[i] === a)
  )
}

/** Entries matching the search words (name, description, category), by category. */
export function catalogGroups(
  query: string,
  entries: readonly CatalogEntry[] = CONNECTOR_CATALOG
): [string, CatalogEntry[]][] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (e: CatalogEntry): boolean => {
    const text = `${e.name} ${e.description} ${e.category} ${e.kind}`.toLowerCase()
    return words.every((w) => text.includes(w))
  }
  const groups = new Map<string, CatalogEntry[]>()
  for (const e of entries.filter(hit))
    groups.set(e.category, [...(groups.get(e.category) ?? []), e])
  return [...groups.entries()]
}

/** How it signs in, in a few words. */
export function authLine(e: CatalogEntry): string {
  if (e.kind === 'local') return 'Runs on this PC'
  if (e.oauth && e.token) return 'Sign in, or an access token'
  if (e.oauth) return 'Sign in with your account'
  if (e.token?.required) return 'Needs an access token'
  if (e.token) return 'No sign-in needed (token optional)'
  return 'No sign-in needed'
}

export interface CatalogChoice {
  /** Remote: sign in (OAuth) or paste a token. */
  method: 'oauth' | 'token' | 'none'
  token: string
  /** Local: folders, one per line. */
  folders: string
}

/** The connectors:add request for an entry, or why it cannot be added yet. */
export function catalogInput(
  e: CatalogEntry,
  c: CatalogChoice,
  taken: readonly string[],
  trusted: boolean
): { input: ConnectorInput } | { error: string } {
  const id = taken.includes(e.id) ? idFromName(e.name, taken) : e.id
  if (!id) return { error: 'No free id for this connector.' }
  if (e.kind === 'remote') {
    if (c.method === 'token' && !c.token.trim()) return { error: 'Paste the access token.' }
    if (e.token?.required && c.method !== 'token' && !e.oauth)
      return { error: 'Paste the access token.' }
    return {
      input: {
        id,
        name: e.name,
        transport: 'http',
        url: e.url,
        ...(c.method === 'oauth' ? { auth: 'oauth' as const } : {}),
        ...(c.method === 'token' && c.token.trim() ? { bearer: c.token.trim() } : {})
      }
    }
  }
  const folders = parseArgs(c.folders)
  if (e.folders && !folders.length) return { error: `${e.folders.label}: add at least one.` }
  if (!trusted) return { error: 'Tick “I trust this command” to add it.' }
  return {
    input: {
      id,
      name: e.name,
      transport: 'stdio',
      command: e.command,
      args: catalogArgs(e, folders),
      trustCommand: true
    }
  }
}

/** The exact command line a local entry would run with these folders. */
export function catalogCommandLine(e: CatalogEntry, folders: string): string {
  return commandLine(e.command, catalogArgs(e, parseArgs(folders)))
}

/** The method an entry starts with. */
export function defaultMethod(e: CatalogEntry): CatalogChoice['method'] {
  if (e.oauth) return 'oauth'
  if (e.token) return e.token.required ? 'token' : 'none'
  return 'none'
}
