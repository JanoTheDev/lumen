// Snippets / voice shortcuts (04 T38): say "insert my calendar link" (or just "my calendar
// link") and the saved text is typed in its place. Stored in ~/.ai-overlay/snippets.json.
// Matching reuses the skill trigger normaliser and similarity, so there is no second grammar.
// Variables: {date}, {time}, {day}, {clipboard}.
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { z } from 'zod'
import { normalizeUtterance, similarity } from '../../skills/triggers'

export const MAX_SNIPPETS = 200
export const MAX_SNIPPET_TEXT = 5000

export const snippetSchema = z
  .object({
    id: z.string().min(1).max(64),
    trigger: z.string().trim().min(2).max(80),
    text: z.string().min(1).max(MAX_SNIPPET_TEXT)
  })
  .strict()
export type Snippet = z.infer<typeof snippetSchema>

const fileSchema = z.object({ version: z.literal(1), snippets: z.array(snippetSchema) })

export function snippetsFile(): string {
  return join(homedir(), '.ai-overlay', 'snippets.json')
}

export function loadSnippets(path = snippetsFile()): Snippet[] {
  if (!existsSync(path)) return []
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) return parsed.data.snippets.slice(0, MAX_SNIPPETS)
    console.warn('[dictation] snippets.json is not valid; ignoring it')
  } catch (e) {
    console.warn('[dictation] snippets.json unreadable:', (e as Error).message)
  }
  return []
}

/** Saves the whole list (ids added where missing, duplicates by trigger dropped). */
export function saveSnippets(
  list: readonly (Omit<Snippet, 'id'> & { id?: string })[],
  path = snippetsFile()
): Snippet[] {
  const seen = new Set<string>()
  const snippets: Snippet[] = []
  for (const s of list.slice(0, MAX_SNIPPETS)) {
    const key = normalizeUtterance(s.trigger)
    if (!key || seen.has(key)) continue
    seen.add(key)
    snippets.push(snippetSchema.parse({ ...s, id: s.id || randomUUID() }))
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, snippets }, null, 2), 'utf8')
  renameSync(tmp, path)
  return snippets
}

const LEAD = /^(?:insert|type|paste|add|put in|write|expand)\s+(?:in\s+)?/
const THRESHOLD = 0.85
/** "my calendar link" and "calendar link" name the same snippet. */
const noMy = (s: string): string => s.replace(/^(?:my|the)\s+/, '')

/** The snippet a whole utterance names, or null. `lead` is true when a lead verb was said. */
export function matchSnippet(
  utterance: string,
  snippets: readonly Snippet[]
): { snippet: Snippet; score: number; lead: boolean } | null {
  const norm = normalizeUtterance(utterance)
  if (norm.length < 2 || norm.length > 100) return null
  const bare = norm.replace(LEAD, '').trim()
  const forms = bare !== norm ? [bare, norm] : [norm]
  let best: { snippet: Snippet; score: number; lead: boolean } | null = null
  for (const snippet of snippets) {
    const phrase = noMy(normalizeUtterance(snippet.trigger))
    if (!phrase) continue
    for (const f of forms) {
      const score = similarity(noMy(f), phrase)
      if (score >= THRESHOLD && (!best || score > best.score))
        best = { snippet, score, lead: f !== norm }
    }
  }
  return best
}

export interface SnippetVars {
  now?: Date
  clipboard?: () => string
}

/** The snippet text with its variables filled in. */
export function expandSnippet(text: string, vars: SnippetVars = {}): string {
  const now = vars.now ?? new Date()
  return text.replace(/\{(date|time|day|clipboard)\}/g, (_m, name: string) => {
    switch (name) {
      case 'date':
        return now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
      case 'time':
        return now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      case 'day':
        return now.toLocaleDateString(undefined, { weekday: 'long' })
      default:
        return vars.clipboard?.() ?? ''
    }
  })
}
