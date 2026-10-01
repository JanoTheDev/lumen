// Automations file: ~/.ai-overlay/automations.json, written atomically. Unreadable entries are
// dropped on load; nothing in it is ever uploaded. Routines (routines.json) and proactive rules
// (config agent.proactive) are imported once each, by id, so nothing is lost and an entry the
// user deleted later does not come back; the old files are left as they are.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import type { Automation } from '@shared/automations'
import type { ProactiveRule, Routine } from '@shared/routines'
import { MAX_AUTOMATIONS } from './engine'
import { validShape } from './preapproval'
import { validTrigger } from './triggers'

export const AUTOMATION_ID_RE = /^(?:au|rt|pr)_[a-z0-9]{4,40}$/

const days = z.array(z.number().int().min(0).max(6)).max(7).optional()
export const triggerSchema = z.union([
  z.object({ kind: z.literal('daily'), at: z.string(), days }).strict(),
  z
    .object({
      kind: z.literal('every'),
      minutes: z.number().int(),
      from: z.string().optional(),
      to: z.string().optional(),
      days
    })
    .strict(),
  z.object({ kind: z.literal('monthly'), day: z.number().int(), at: z.string() }).strict(),
  z.object({ kind: z.literal('once'), at: z.number() }).strict(),
  z.object({ kind: z.literal('startup') }).strict(),
  z.object({ kind: z.literal('online') }).strict(),
  z
    .object({ kind: z.literal('app'), app: z.string().max(60), on: z.enum(['open', 'close']) })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      folder: z.string().max(260),
      on: z.enum(['added', 'changed']),
      pattern: z.string().max(40).optional()
    })
    .strict(),
  z
    .object({ kind: z.literal('idle'), minutes: z.number().int(), on: z.enum(['idle', 'back']) })
    .strict()
])

export const actionSchema = z.union([
  z.object({ kind: z.literal('task'), prompt: z.string().trim().min(1).max(2000) }).strict(),
  z
    .object({
      kind: z.literal('skill'),
      skill: z.string().trim().min(1).max(80),
      prompt: z.string().max(2000).optional()
    })
    .strict(),
  z.object({ kind: z.literal('remind'), say: z.string().trim().min(1).max(300) }).strict()
])

const result = z.enum(['done', 'failed', 'cancelled'])

const runSchema = z
  .object({
    at: z.number(),
    result: z.union([result, z.literal('skipped')]),
    via: z.enum(['time', 'event', 'manual', 'wake', 'catch-up']),
    summary: z.string().max(300).optional(),
    taskId: z.string().max(80).optional()
  })
  .strict()

export const automationSchema = z
  .object({
    id: z.string().regex(AUTOMATION_ID_RE),
    name: z.string().trim().min(1).max(80),
    trigger: triggerSchema.refine(
      (t) => validTrigger(t as Automation['trigger']),
      'invalid trigger'
    ),
    action: actionSchema,
    preApproved: z.array(z.custom(validShape)).max(20),
    enabled: z.boolean(),
    failures: z.number().int().min(0).max(100),
    createdAt: z.number(),
    wake: z.boolean().optional(),
    catchUp: z.boolean().optional(),
    lastRunAt: z.number().optional(),
    lastResult: result.optional(),
    disabledReason: z.string().max(300).optional(),
    runs: z.array(runSchema).max(20).optional()
  })
  .strict()

export function parseAutomations(raw: unknown): Automation[] {
  const list = (raw as { automations?: unknown } | null)?.automations
  if (!Array.isArray(list)) return []
  const out: Automation[] = []
  for (const a of list) {
    const p = automationSchema.safeParse(a)
    if (p.success && !out.some((o) => o.id === p.data.id)) out.push(p.data as Automation)
  }
  return out.slice(0, MAX_AUTOMATIONS)
}

// ---- migration ----

export function routineToAutomation(r: Routine): Automation {
  return {
    id: r.id,
    name: r.name,
    trigger: { ...r.schedule },
    action: { kind: 'task', prompt: r.prompt },
    preApproved: r.preApproved.map((s) => ({ ...s })),
    enabled: r.enabled,
    failures: r.failures,
    createdAt: r.createdAt,
    ...(r.lastRunAt !== undefined ? { lastRunAt: r.lastRunAt } : {}),
    ...(r.lastResult ? { lastResult: r.lastResult } : {}),
    ...(r.disabledReason ? { disabledReason: r.disabledReason } : {})
  }
}

/** A proactive rule is an app-open automation that says its line; on only if the mode was. */
export function ruleToAutomation(rule: ProactiveRule, modeOn: boolean, now: number): Automation {
  return {
    id: rule.id,
    name: `When I open ${rule.app}`.slice(0, 80),
    trigger: { kind: 'app', app: rule.app, on: 'open' },
    action: { kind: 'remind', say: rule.say },
    preApproved: [],
    enabled: modeOn,
    failures: 0,
    createdAt: now
  }
}

export interface Legacy {
  routines: Routine[]
  proactive: { enabled: boolean; rules: ProactiveRule[] }
}

/**
 * Adds every routine and rule not imported before. Returns the merged list and the imported
 * ids; `changed` when anything was added.
 */
export function mergeLegacy(
  current: Automation[],
  imported: string[],
  legacy: Legacy,
  now: number
): { list: Automation[]; imported: string[]; changed: boolean } {
  const list = [...current]
  const done = new Set(imported)
  let changed = false
  const add = (a: Automation): void => {
    done.add(a.id)
    changed = true
    if (list.length >= MAX_AUTOMATIONS || list.some((x) => x.id === a.id)) return
    if (!automationSchema.safeParse(a).success) return
    list.push(a)
  }
  for (const r of legacy.routines) if (!done.has(r.id)) add(routineToAutomation(r))
  for (const rule of legacy.proactive.rules)
    if (!done.has(rule.id)) add(ruleToAutomation(rule, legacy.proactive.enabled, now))
  return { list, imported: [...done], changed }
}

export class AutomationStore {
  private imported: string[] = []

  constructor(
    private readonly file: string | null,
    private readonly legacy: () => Legacy = () => ({
      routines: [],
      proactive: { enabled: false, rules: [] }
    })
  ) {}

  load(now = Date.now()): Automation[] {
    let list: Automation[] = []
    if (this.file && existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { imported?: unknown }
        list = parseAutomations(raw)
        this.imported = Array.isArray(raw.imported)
          ? raw.imported.filter((x): x is string => typeof x === 'string').slice(0, 500)
          : []
      } catch (e) {
        console.warn('[automations] unreadable automations file:', (e as Error).message)
        // Kept aside; the routines and rules are imported again.
        try {
          renameSync(this.file, this.file.replace(/\.json$/, `.invalid.${now}.json`))
        } catch {
          /* best effort */
        }
        list = []
        this.imported = []
      }
    }
    let legacy: Legacy
    try {
      legacy = this.legacy()
    } catch {
      return list
    }
    const merged = mergeLegacy(list, this.imported, legacy, now)
    this.imported = merged.imported
    if (merged.changed) this.save(merged.list)
    return merged.list
  }

  save(list: Automation[]): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      const body = { version: 1, automations: list, imported: this.imported }
      writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      console.warn('[automations] save failed:', (e as Error).message)
    }
  }
}
