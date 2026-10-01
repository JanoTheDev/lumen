// Secret redaction (safety-policy §3). Detection lives in ai/memory/sensitive (one detector for
// memory, logs, model input and typed output); this module adds what the action path needs:
// which secrets a typed text holds, masked for the confirm card, and the log/model rewrites.
import { findSensitive, redact, type SensitiveKind } from '../ai/memory/sensitive'

/** Kinds that make typed text a secret (API keys, JWTs, private keys, cards, IBANs). */
const SECRET_KINDS = new Set<SensitiveKind>(['api-key', 'private-key', 'card', 'iban'])

export interface SecretHit {
  kind: SensitiveKind
  start: number
  end: number
  /** Safe to show: "sk-…7f3a", "•••• 4242". */
  masked: string
}

export function maskSecret(kind: SensitiveKind, value: string): string {
  const v = value.trim()
  if (kind === 'private-key') return '[private key]'
  if (kind === 'card') return `•••• ${v.replace(/\D/g, '').slice(-4)}`
  if (kind === 'iban') return `${v.slice(0, 2)}•• •••• ${v.replace(/\s/g, '').slice(-4)}`
  return v.length <= 8 ? '••••' : `${v.slice(0, 3)}…${v.slice(-4)}`
}

/** Secrets in text that is about to be typed. */
export function findSecrets(text: string): SecretHit[] {
  return findSensitive(text)
    .filter((h) => SECRET_KINDS.has(h.kind))
    .map((h) => ({ ...h, masked: maskSecret(h.kind, text.slice(h.start, h.end)) }))
}

/** Text with every secret replaced by its masked form (confirm card, audit summary). */
export function maskSecrets(text: string): string {
  let out = ''
  let pos = 0
  for (const h of findSecrets(text)) {
    if (h.start < pos) continue
    out += text.slice(pos, h.start) + h.masked
    pos = h.end
  }
  return out + text.slice(pos)
}

/** Log lines: every sensitive span becomes `[redacted:<kind>]`. */
export function redactForLog(text: string): string {
  return redact(text)
}

/** Model input (screen text, page text, tool results): same rewrite as the log. */
export function redactForModel(text: string): string {
  return redact(text)
}
