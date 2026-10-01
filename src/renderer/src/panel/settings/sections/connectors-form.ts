// Pure helpers of the Add connector form (tested without a DOM).
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** A server id from the name: lowercase, dashes, ≤ 20 characters, unique among `taken`. */
export function idFromName(name: string, taken: readonly string[]): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/, '')
  if (!base) return ''
  if (!taken.includes(base)) return base
  for (let i = 2; i < 100; i++) {
    const id = `${base.slice(0, 17).replace(/-+$/, '')}-${i}`
    if (!taken.includes(id)) return id
  }
  return ''
}

/** One argument per line; blank lines are dropped, spaces inside a line are kept. */
export function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

/** NAME=value lines. */
export function parseEnv(text: string): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const eq = line.indexOf('=')
    const name = eq > 0 ? line.slice(0, eq).trim() : ''
    if (!ENV_NAME_RE.test(name))
      return { env: {}, error: `Use NAME=value lines (“${line.slice(0, eq > 0 ? eq : 20)}”).` }
    env[name] = line.slice(eq + 1)
  }
  return { env }
}
