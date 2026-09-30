import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'

export interface GuideStep {
  label: string
  target_hint: string
  bbox?: [number, number, number, number]
}

export interface SavedGuide {
  id: string
  name: string
  task: string
  steps: GuideStep[]
  createdAt: number
}

export const GUIDE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

let dirOverride: string | null = null

// Tests point this at a temp dir; pass null to restore the default location.
export function setGuidesDir(dir: string | null): void {
  dirOverride = dir
}

export function guidesDir(): string {
  const dir = dirOverride ?? join(homedir(), '.ai-overlay', 'guides')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'guide'
  )
}

export function isValidGuideId(id: unknown): id is string {
  return typeof id === 'string' && GUIDE_ID_RE.test(id)
}

// Returns the on-disk path for an id, or null if the id is malformed or escapes the dir.
export function guidePath(id: unknown): string | null {
  if (!isValidGuideId(id)) return null
  const dir = resolve(guidesDir())
  const file = resolve(dir, `${id}.json`)
  return file.startsWith(dir + sep) ? file : null
}

export function listSavedGuides(): SavedGuide[] {
  try {
    const dir = guidesDir()
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf8')) as SavedGuide
        } catch {
          return null
        }
      })
      .filter((g): g is SavedGuide => g !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export function saveGuide(task: string, steps: GuideStep[], name?: string): SavedGuide {
  const now = Date.now()
  const suffix = now.toString(36)
  // Keep the full id within the 64-char limit enforced by GUIDE_ID_RE.
  const base =
    slugify(name || task)
      .slice(0, 63 - suffix.length)
      .replace(/-$/, '') || 'guide'
  const id = `${base}-${suffix}`
  const entry: SavedGuide = {
    id,
    name: name?.trim() || task.slice(0, 60),
    task,
    steps,
    createdAt: now
  }
  const file = guidePath(id)
  if (!file) throw new Error(`invalid guide id: ${id}`)
  writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8')
  return entry
}

export function deleteSavedGuide(id: unknown): boolean {
  const file = guidePath(id)
  if (!file) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

export function loadSavedGuide(id: unknown): SavedGuide | null {
  const file = guidePath(id)
  if (!file) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SavedGuide
  } catch {
    return null
  }
}

// Case-insensitive lookup by name, falling back to slug containment.
export function findGuideByName(query: string): SavedGuide | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return null
  const guides = listSavedGuides()
  return (
    guides.find((g) => g.name.toLowerCase().includes(needle)) ??
    guides.find((g) => slugify(g.name).includes(slugify(needle))) ??
    null
  )
}
