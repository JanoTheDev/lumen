// Project registry (08 T34): folders Claude Code has worked in (~/.claude/projects, one dir per
// project with <session>.jsonl transcripts) plus folders the user added in Settings, matched by
// spoken name ("open lumen", "the ai overlay project").
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { ClaudeProject, ClaudeProjectEntry } from '@shared/claude-code'

export function claudeHome(): string {
  return join(homedir(), '.claude')
}

const HEAD_BYTES = 64 * 1024
const MAX_PROJECTS = 200
const TEMP_RE = /[\\/](appdata[\\/]local[\\/]temp|tmp)[\\/]/i

/** Throwaway folders (probes, scratch runs) are not projects. */
export function isTempPath(p: string): boolean {
  return TEMP_RE.test(`${p}\\`)
}

function readHead(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The project folder a transcript was written in (its first line with a "cwd"). */
export function cwdFromTranscript(head: string): string | null {
  for (const line of head.split('\n')) {
    if (!line.includes('"cwd"')) continue
    try {
      const v = JSON.parse(line) as { cwd?: unknown }
      if (typeof v.cwd === 'string' && v.cwd) return v.cwd
    } catch {
      /* a cut-off last line */
    }
  }
  return null
}

const JOINERS = ['-', ' ', '.', '_']
const MAX_JOIN = 4

/**
 * "C--Users-me-Desktop-Random-Projects-ai-overlay" → "C:\Users\me\Desktop\Random Projects\ai-overlay"
 * by walking the disk: the name is lossy (":", "\", " " and "." all became "-").
 */
export function decodeProjectDir(name: string, exists = existsSync): string | null {
  const m = /^([A-Za-z])--(.*)$/.exec(name)
  if (!m) return null
  const tokens = m[2].split('-')
  const walk = (base: string, rest: string[], depth: number): string | null => {
    if (!rest.length) return base
    if (depth > 40) return null
    for (let k = 1; k <= Math.min(MAX_JOIN, rest.length); k++) {
      for (const seg of segments(rest.slice(0, k))) {
        const next = join(base, seg)
        if (!exists(next)) continue
        const r = walk(next, rest.slice(k), depth + 1)
        if (r) return r
      }
    }
    return null
  }
  return walk(`${m[1].toUpperCase()}:\\`, tokens, 0)
}

function segments(parts: string[]): string[] {
  if (parts.length === 1) return parts
  const out: string[] = []
  for (const tail of segments(parts.slice(1)))
    for (const j of JOINERS) out.push(`${parts[0]}${j}${tail}`)
  return out
}

/** Projects from ~/.claude/projects, newest first. Temp folders and gone folders are skipped. */
export function listClaudeProjects(
  dir = join(claudeHome(), 'projects'),
  skip: (path: string) => boolean = isTempPath
): ClaudeProject[] {
  if (!existsSync(dir)) return []
  const out: ClaudeProject[] = []
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name)
    let newest: { file: string; mtime: number } | null = null
    try {
      for (const f of readdirSync(sub)) {
        if (!f.endsWith('.jsonl')) continue
        const mtime = statSync(join(sub, f)).mtimeMs
        if (!newest || mtime > newest.mtime) newest = { file: join(sub, f), mtime }
      }
    } catch {
      continue
    }
    let path: string | null = null
    if (newest) {
      try {
        path = cwdFromTranscript(readHead(newest.file))
      } catch {
        /* unreadable transcript: decode the name */
      }
    }
    path ??= decodeProjectDir(name)
    if (!path || skip(path) || !existsSync(path)) continue
    out.push({ path, name: basename(path), source: 'claude', lastActive: newest?.mtime })
  }
  return dedupe(out.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))).slice(
    0,
    MAX_PROJECTS
  )
}

export function samePath(a: string, b: string): boolean {
  const n = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
  return n(a) === n(b)
}

function dedupe(list: ClaudeProject[]): ClaudeProject[] {
  const out: ClaudeProject[] = []
  for (const p of list) if (!out.some((o) => samePath(o.path, p.path))) out.push(p)
  return out
}

/** Claude's projects plus the user's folders, with the user's per-project settings applied. */
export function mergeProjects(
  found: ClaudeProject[],
  entries: ClaudeProjectEntry[]
): ClaudeProject[] {
  const out = found.map((p) => ({ ...p }))
  for (const e of entries) {
    const hit = out.find((p) => samePath(p.path, e.path))
    const extra = {
      ...(e.name ? { name: e.name } : {}),
      ...(e.autopilot ? { autopilot: e.autopilot } : {}),
      ...(e.allowedTools ? { allowedTools: e.allowedTools } : {}),
      ...(e.notes ? { notes: e.notes } : {})
    }
    if (hit) Object.assign(hit, extra)
    else out.push({ path: e.path, name: basename(e.path), source: 'user', ...extra })
  }
  return out
}

// ---- spoken match ----

const FILLER_RE = /\b(the|my|project|projects|repo|repository|folder|codebase|app|in|on)\b/g

function words(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

function spokenWords(s: string): string[] {
  return words(s.toLowerCase().replace(FILLER_RE, ' '))
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[b.length]
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  return 1 - lev(a, b) / Math.max(a.length, b.length)
}

/** 0..1: how well the spoken name fits the project (name, folder name, path tail). */
export function projectScore(spoken: string, p: ClaudeProject): number {
  const said = spokenWords(spoken)
  if (!said.length) return 0
  const saidJoined = said.join('')
  let best = 0
  for (const label of new Set([p.name, basename(p.path)])) {
    const w = words(label)
    const joined = w.join('')
    if (joined === saidJoined) return 1
    if (said.every((s) => w.includes(s))) best = Math.max(best, 0.9)
    best = Math.max(best, similarity(saidJoined, joined) * 0.95)
    // "lumen" for a folder "lumen-app": a whole leading word.
    if (w[0] === saidJoined) best = Math.max(best, 0.85)
  }
  return best
}

export const MATCH_MIN = 0.7

export function matchProject(spoken: string, projects: ClaudeProject[]): ClaudeProject | null {
  let best: { p: ClaudeProject; s: number } | null = null
  for (const p of projects) {
    const s = projectScore(spoken, p)
    // Ties go to the most recent project (the list is newest first).
    if (s >= MATCH_MIN && (!best || s > best.s)) best = { p, s }
  }
  return best?.p ?? null
}
