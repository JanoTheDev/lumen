// Detects text that must never be written to memory: secrets, card/IBAN numbers, IDs, one-time codes.

export type SensitiveKind =
  | 'api-key'
  | 'private-key'
  | 'card'
  | 'iban'
  | 'password'
  | 'one-time-code'
  | 'government-id'
  | 'email'

export interface SensitiveHit {
  kind: SensitiveKind
  start: number
  end: number
}

export interface SensitiveOptions {
  /** Treat email addresses as sensitive too (off by default; the user may want "my work email is …"). */
  emails?: boolean
}

interface Rule {
  kind: SensitiveKind
  re: RegExp
  check?: (match: string) => boolean
}

const RULES: Rule[] = [
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
  },
  {
    kind: 'api-key',
    re: /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}|(?:pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{30,})/g
  },
  { kind: 'api-key', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: 'api-key',
    re: /\b(?:api[_ -]?key|secret|token|bearer)\b\s*(?:is|=|:)?\s*["']?[A-Za-z0-9_\-./+]{16,}/gi
  },
  {
    kind: 'password',
    re: /\b(?:password|passwort|passcode|passphrase|pwd|pin)\b\s*(?:is|was|=|:)\s*\S+/gi
  },
  {
    kind: 'one-time-code',
    re: /\b(?:otp|2fa|one[- ]time|verification|security|login|auth(?:entication)?)\s*(?:code|pin)?\s*(?:is|was|=|:)?\s*\d{4,8}\b/gi
  },
  { kind: 'government-id', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    kind: 'government-id',
    re: /\b(?:passport|social security|ssn|national id|id card|tax id|driver'?s licen[cs]e)(?:\s+(?:number|no\.?|#))?\s*(?:is|=|:)?\s*[A-Z0-9-]{5,}/gi
  },
  { kind: 'card', re: /\b\d(?:[ -]?\d){12,18}\b/g, check: (m) => luhn(m.replace(/\D/g, '')) },
  {
    kind: 'iban',
    re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g,
    check: (m) => ibanValid(m.replace(/\s/g, ''))
  }
]

const EMAIL_RULE: Rule = { kind: 'email', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g }

export function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

export function ibanValid(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let rem = 0
  for (const ch of rearranged) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)
    for (const d of v) rem = (rem * 10 + Number(d)) % 97
  }
  return rem === 1
}

export function findSensitive(text: string, opts: SensitiveOptions = {}): SensitiveHit[] {
  const rules = opts.emails ? [...RULES, EMAIL_RULE] : RULES
  const hits: SensitiveHit[] = []
  for (const rule of rules) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.check && !rule.check(m[0])) continue
      hits.push({ kind: rule.kind, start: m.index, end: m.index + m[0].length })
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}

export function isSensitive(text: string, opts?: SensitiveOptions): boolean {
  return findSensitive(text, opts).length > 0
}

/** Replaces every sensitive span with `[redacted:<kind>]`. */
export function redact(text: string, opts?: SensitiveOptions): string {
  let out = ''
  let pos = 0
  for (const hit of findSensitive(text, opts)) {
    if (hit.start < pos) {
      pos = Math.max(pos, hit.end)
      continue
    }
    out += text.slice(pos, hit.start) + `[redacted:${hit.kind}]`
    pos = hit.end
  }
  return out + text.slice(pos)
}
