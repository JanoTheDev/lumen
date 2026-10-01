// Learning journal (11 T23): a per-day note in ~/.ai-overlay/journal/YYYY-MM-DD.md of what
// the user did and learned (questions asked, lessons finished, shortcuts learned, apps used).
// Opt-in and local. The day's data lives beside the note as .data/YYYY-MM-DD.json so the
// markdown is regenerated on each change; "what did I learn this week?" reads the data.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { redactForLog } from '../actions/redact'

export interface JournalDay {
  date: string
  questions: string[]
  lessons: string[]
  shortcuts: string[]
  apps: string[]
}

export type JournalEntry =
  | { kind: 'question'; text: string }
  | { kind: 'lesson'; title: string }
  | { kind: 'shortcut'; text: string }
  | { kind: 'app'; name: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_QUESTIONS = 200
const MAX_QUESTION = 160

/** Local calendar day (the note follows the user's day, not UTC). */
export function dayOf(t: number): string {
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const emptyDay = (date: string): JournalDay => ({
  date,
  questions: [],
  lessons: [],
  shortcuts: [],
  apps: []
})

/** Adds an entry (de-duplicated); returns the same object when nothing changed. */
export function addEntry(day: JournalDay, e: JournalEntry): JournalDay {
  const push = (list: string[], v: string, max = 100): string[] =>
    !v || list.includes(v) || list.length >= max ? list : [...list, v]
  switch (e.kind) {
    case 'question': {
      // Spoken passwords and pasted keys never reach the plain-text note.
      const q = redactForLog(e.text).replace(/\s+/g, ' ').trim()
      const text = q.length > MAX_QUESTION ? `${q.slice(0, MAX_QUESTION - 1)}…` : q
      const questions = push(day.questions, text, MAX_QUESTIONS)
      return questions === day.questions ? day : { ...day, questions }
    }
    case 'lesson': {
      const lessons = push(day.lessons, e.title)
      return lessons === day.lessons ? day : { ...day, lessons }
    }
    case 'shortcut': {
      const shortcuts = push(day.shortcuts, e.text)
      return shortcuts === day.shortcuts ? day : { ...day, shortcuts }
    }
    case 'app': {
      const apps = push(day.apps, e.name, 50)
      return apps === day.apps ? day : { ...day, apps }
    }
  }
}

const bullets = (items: string[]): string =>
  items.map((i) => `- ${i.replace(/\n/g, ' ')}`).join('\n')

export function dayMarkdown(day: JournalDay): string {
  const parts = [`# Learning journal: ${day.date}`]
  if (day.lessons.length) parts.push(`## Lessons finished\n\n${bullets(day.lessons)}`)
  if (day.shortcuts.length) parts.push(`## New shortcuts\n\n${bullets(day.shortcuts)}`)
  if (day.apps.length) parts.push(`## Apps you worked in\n\n${bullets(day.apps)}`)
  if (day.questions.length) parts.push(`## Questions you asked\n\n${bullets(day.questions)}`)
  if (parts.length === 1) parts.push('Nothing noted yet.')
  return `${parts.join('\n\n')}\n`
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** "What did I learn this week?" from the days given (any order). */
export function summarize(days: JournalDay[], range: 'today' | 'week'): string {
  const when = range === 'today' ? 'today' : 'this week'
  const lessons = days.flatMap((d) => d.lessons)
  const shortcuts = days.flatMap((d) => d.shortcuts)
  const questions = days.reduce((n, d) => n + d.questions.length, 0)
  const apps = [...new Set(days.flatMap((d) => d.apps))]
  if (!lessons.length && !shortcuts.length && !questions && !apps.length)
    return `Your journal has nothing for ${when} yet.`
  const lines: string[] = []
  if (lessons.length)
    lines.push(
      `You finished ${plural(lessons.length, 'lesson')}: ${[...new Set(lessons)].slice(0, 5).join(', ')}.`
    )
  if (shortcuts.length)
    lines.push(`You started using ${[...new Set(shortcuts)].slice(0, 5).join(', ')}.`)
  if (apps.length) lines.push(`You worked in ${apps.slice(0, 5).join(', ')}.`)
  if (questions) lines.push(`You asked me ${plural(questions, 'question')}.`)
  return `${range === 'today' ? 'Today' : 'This week'}: ${lines.join(' ')}`
}

export class JournalStore {
  constructor(private readonly dir: string) {}

  private dataFile(date: string): string {
    return join(this.dir, '.data', `${date}.json`)
  }

  read(date: string): JournalDay {
    if (!DATE_RE.test(date)) return emptyDay(date)
    try {
      const raw = JSON.parse(readFileSync(this.dataFile(date), 'utf8')) as Partial<JournalDay>
      const arr = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
      return {
        date,
        questions: arr(raw.questions),
        lessons: arr(raw.lessons),
        shortcuts: arr(raw.shortcuts),
        apps: arr(raw.apps)
      }
    } catch {
      return emptyDay(date)
    }
  }

  add(e: JournalEntry, now = Date.now()): void {
    const date = dayOf(now)
    const day = this.read(date)
    const next = addEntry(day, e)
    if (next === day) return
    mkdirSync(join(this.dir, '.data'), { recursive: true })
    writeFileSync(this.dataFile(date), JSON.stringify(next), 'utf8')
    writeFileSync(join(this.dir, `${date}.md`), dayMarkdown(next), 'utf8')
  }

  /** Days with a note, newest first. */
  days(): string[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .map((n) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(n)?.[1])
      .filter((d): d is string => !!d)
      .sort()
      .reverse()
  }

  markdown(date: string): string | null {
    if (!DATE_RE.test(date)) return null
    try {
      return readFileSync(join(this.dir, `${date}.md`), 'utf8')
    } catch {
      return null
    }
  }

  /** The last `n` days including today (missing days are empty). */
  recent(n: number, now = Date.now()): JournalDay[] {
    return Array.from({ length: n }, (_, i) => this.read(dayOf(now - i * 86_400_000)))
  }

  clear(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}
