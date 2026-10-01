// Routines file: ~/.ai-overlay/routines.json, written atomically. Unreadable entries are
// dropped on load; nothing in it is ever uploaded.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import type { Routine } from '@shared/routines'
import { validShape } from './preapproval'
import { validSchedule } from './schedule'

export const MAX_ROUTINES = 30
export const ROUTINE_ID_RE = /^rt_[a-z0-9]{4,40}$/

const scheduleSchema = z.union([
  z
    .object({
      kind: z.literal('daily'),
      at: z.string(),
      days: z.array(z.number().int().min(0).max(6)).max(7).optional()
    })
    .strict(),
  z.object({ kind: z.literal('every'), minutes: z.number().int() }).strict()
])

export const routineSchema = z
  .object({
    id: z.string().regex(ROUTINE_ID_RE),
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(2000),
    schedule: scheduleSchema.refine(validSchedule, 'invalid schedule'),
    preApproved: z.array(z.custom(validShape)).max(20),
    enabled: z.boolean(),
    failures: z.number().int().min(0).max(100),
    createdAt: z.number(),
    lastRunAt: z.number().optional(),
    lastResult: z.enum(['done', 'failed', 'cancelled']).optional(),
    disabledReason: z.string().max(300).optional()
  })
  .strict()

export function parseRoutines(raw: unknown): Routine[] {
  const list = (raw as { routines?: unknown } | null)?.routines
  if (!Array.isArray(list)) return []
  const out: Routine[] = []
  for (const r of list) {
    const p = routineSchema.safeParse(r)
    if (p.success && !out.some((o) => o.id === p.data.id)) out.push(p.data as Routine)
  }
  return out.slice(0, MAX_ROUTINES)
}

export class RoutineStore {
  constructor(private readonly file: string | null) {}

  load(): Routine[] {
    if (!this.file || !existsSync(this.file)) return []
    try {
      return parseRoutines(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (e) {
      console.warn('[routines] unreadable routines file:', (e as Error).message)
      return []
    }
  }

  save(routines: Routine[]): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ routines }, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      console.warn('[routines] save failed:', (e as Error).message)
    }
  }
}
