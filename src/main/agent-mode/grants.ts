// Permission grants (safety-policy §5): "Always for <app / site / tool>" answers to a medium
// confirm. Stored in ~/.ai-overlay/grants.json, written atomically. High risk is never
// grantable, so only medium scopes are ever stored.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { GrantLookup } from '../actions/safety'

export interface Grant {
  /** "app:<process>" | "mcp:<server>/<tool>" | "domain:<site>" | "scheme:mailto" */
  scope: string
  level: 'medium'
  createdAt: string
}

const SCOPE_RE = /^(app|mcp|domain|scheme):[^\s]{1,200}$/

export function validScope(scope: string): boolean {
  return SCOPE_RE.test(scope)
}

export class GrantStore implements GrantLookup {
  private grants: Grant[] = []

  /** `file` null keeps grants in memory only (tests, no install yet). */
  constructor(private readonly file: string | null = null) {
    if (file) this.grants = load(file)
  }

  list(): Grant[] {
    return this.grants.map((g) => ({ ...g }))
  }

  has(scope: string): boolean {
    return this.grants.some((g) => g.scope === scope)
  }

  /** Grants a medium scope. Anything else (high, blocked, a malformed scope) is refused. */
  add(scope: string, level: string = 'medium'): boolean {
    if (level !== 'medium' || !validScope(scope)) return false
    if (this.has(scope)) return true
    this.grants.push({ scope, level: 'medium', createdAt: new Date().toISOString() })
    this.save()
    return true
  }

  revoke(scope: string): boolean {
    const before = this.grants.length
    this.grants = this.grants.filter((g) => g.scope !== scope)
    if (this.grants.length === before) return false
    this.save()
    return true
  }

  private save(): void {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ grants: this.grants }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}

function load(file: string): Grant[] {
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { grants?: unknown }
    if (!Array.isArray(raw.grants)) return []
    return raw.grants.filter(
      (g): g is Grant =>
        !!g &&
        typeof g === 'object' &&
        typeof (g as Grant).scope === 'string' &&
        validScope((g as Grant).scope) &&
        (g as Grant).level === 'medium'
    )
  } catch {
    // A broken file grants nothing; the next save replaces it.
    return []
  }
}

let store = new GrantStore()

/** Loads ~/.ai-overlay/grants.json (index.ts at startup; tests pass a temp file). */
export function installGrants(file: string): GrantStore {
  store = new GrantStore(file)
  return store
}

export function grants(): GrantStore {
  return store
}
