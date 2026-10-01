// Least-privilege limits shared by model-written skills (compose.ts) and model edits (edit.ts):
// https origins only (a wildcard needs a registrable domain, never a public suffix such as
// `*.com` or `*.co.uk`) and the agent tools a skill may list. Pure.

/** Agent tools a skill may list (the foreground set plus memory and skill files). */
export const SKILL_TOOL_NAMES = [
  'observe',
  'act',
  'keys',
  'navigate',
  'launch_app',
  'wait_for',
  'ask_user',
  'focus_mode',
  'read_file',
  'memory_search',
  'use_skill',
  'read_skill_file',
  'finish'
] as const
export const INPUT_TOOL_NAMES = new Set(['act', 'keys', 'navigate', 'launch_app'])

/** Second-level labels registries sell under a country code ("co.uk", "com.au", "ne.jp"). */
const SLD = new Set(['ac', 'co', 'com', 'edu', 'gob', 'gov', 'ltd', 'me', 'ne', 'net', 'or', 'org'])
/** Shared hosting suffixes anyone can get a subdomain of. */
const SHARED = new Set([
  'appspot.com',
  'azurewebsites.net',
  'blogspot.com',
  'cloudfront.net',
  'firebaseapp.com',
  'github.io',
  'gitlab.io',
  'herokuapp.com',
  'netlify.app',
  'pages.dev',
  'vercel.app',
  'web.app',
  'workers.dev'
])

/** `*.<domain>` covers one site, not a whole top-level or shared domain. */
export function isPublicSuffix(domain: string): boolean {
  const labels = domain.split('.')
  if (labels.length < 2 || labels.some((l) => !l)) return true
  if (SHARED.has(domain)) return true
  return labels.length === 2 && labels[1].length === 2 && SLD.has(labels[0])
}

/** "https://mail.google.com/x" → "https://mail.google.com"; null when not an https origin. */
export function websitePattern(raw: string): string | null {
  const t = raw.trim()
  const wild = /^https:\/\/\*\.((?:[a-z0-9-]+\.)+[a-z]{2,})$/i.exec(t)
  if (wild) {
    const domain = wild[1].toLowerCase()
    return isPublicSuffix(domain) ? null : `https://*.${domain}`
  }
  if (t.includes('*')) return null
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`)
    if (u.protocol !== 'https:' || !u.hostname.includes('.')) return null
    if (u.username || u.password) return null
    return `https://${u.host.toLowerCase()}`
  } catch {
    return null
  }
}

/** "https://*.example.com" → "any page on example.com"; "https://a.com" → "a.com". */
export function websiteWords(pattern: string): string {
  const host = pattern.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return host.startsWith('*.') ? `any page on ${host.slice(2)}` : host
}
