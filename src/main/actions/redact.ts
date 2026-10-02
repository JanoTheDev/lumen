// Secret redaction (safety-policy §3). Detection lives in ai/memory/sensitive (one detector for
// memory, logs, model input and typed output); this module adds what the action path needs:
// which secrets a typed text holds, masked for the confirm card, and the log/model rewrites.
import { findSensitive, luhn, redact, type SensitiveKind } from '../ai/memory/sensitive'

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

/**
 * Config-file secrets the detector misses: `DB_PASSWORD=…`, `"client_secret": "…"`,
 * `GITHUB_TOKEN: …` (a name ending in password / secret / token / api key / access key / private
 * key / credentials, or with an `_…` suffix after it; "tokens" counters are not secrets).
 */
const CONFIG_SECRET_RE =
  /\b([A-Za-z0-9_.-]*?(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)(?:_[A-Za-z0-9_]*)?["']?\s*[=:]\s*["']?)([^\s"',;&]{4,})/gi

/** `scheme://user:password@host`: the password part. */
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/@]+)@/gi

function redactConfigSecrets(text: string): string {
  return text
    .replace(URL_USERINFO_RE, (_m, head: string) => `${head}:[redacted:password]@`)
    .replace(CONFIG_SECRET_RE, (m, name: string, value: string) =>
      value.startsWith('[redacted:') ? m : `${name}[redacted:password]`
    )
}

/** A card security code after its label ("CVC: 123", "Prüfnummer 1234", nl/de/fr/es too). */
const CVC_LABEL_RE =
  /\b(cvc2?|cvv2?|csc|security code|card verification(?: code| value)?|beveiligingscode|kaartcode|kartenprüfnummer|prüfnummer|sicherheitscode|cryptogramme(?: visuel)?|code de sécurité|código de seguridad)(\s*(?:is|was|=|:|-|#)?\s*)\d{3,4}(?!\d)/giu

/** "[redacted:card] 12/27 123": the 3-4 digits right after a card number (and its expiry). */
const CVC_AFTER_CARD_RE =
  /(\[redacted:card\](?:[ \t]*[,;]?[ \t]*(?:exp\w*\.?:?[ \t]*)?\d{1,2}[ \t]*\/[ \t]*\d{2,4})?[ \t]*[,;]?[ \t]*(?:cvc|cvv)?:?[ \t]*)\d{3,4}(?![\d/.-])/gi

/**
 * Card numbers in their printed groups (4-4-4-4, Amex 4-6-5) even when more digits follow
 * ("4242 4242 4242 4242 12/27"), where the detector's longer run fails the Luhn check. Groups
 * may be split by a space, two spaces, a dash, a dot or an underscore.
 */
const CARD_GROUPS_RE =
  /(?<![\d-])(?:\d{4}([ ._-]{0,2})\d{4}\1\d{4}\1\d{4}|\d{4}([ ._-]{0,2})\d{6}\2\d{5})(?![\d-])/g

/** The text holds a number that passes the card check (Luhn), grouped or not (full-width
 * digits count as digits). */
export function hasCardNumber(text: string): boolean {
  const t = text.normalize('NFKC')
  if (findSensitive(t).some((h) => h.kind === 'card')) return true
  return [...t.matchAll(CARD_GROUPS_RE)].some((m) => luhn(m[0].replace(/\D/g, '')))
}

function redactCardGroups(text: string): string {
  return text.replace(CARD_GROUPS_RE, (m) => (luhn(m.replace(/\D/g, '')) ? '[redacted:card]' : m))
}

/** Card security codes next to their label or a card number (cards and IBANs: the detector). */
function redactPayment(text: string): string {
  return text
    .replace(CVC_LABEL_RE, (_m, label: string, gap: string) => `${label}${gap}[redacted:cvc]`)
    .replace(CVC_AFTER_CARD_RE, (_m, head: string) => `${head}[redacted:cvc]`)
}

/** Log lines: every sensitive span becomes `[redacted:<kind>]`. */
export function redactForLog(text: string): string {
  return redactPayment(redact(redactCardGroups(redactConfigSecrets(text))))
}

/** Model input (screen text, page text, tool results): same rewrite as the log. */
export function redactForModel(text: string): string {
  return redactPayment(redact(redactCardGroups(redactConfigSecrets(text))))
}
