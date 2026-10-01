// Community accessibility labels (11 T13): names for unnamed controls, one file per app in
// ~/.ai-overlay/labels/<app>.json. The same shape is an app pack's labels.json (skills/<app>/
// labels.json), so a user's labels can be shared in a `.lumen` file or added to a pack by pull
// request. Each label says where it came from (source ai | human, with a confidence) so a
// person can review AI guesses. A label is found by automation id (+ role) first, then by icon
// hash. Human labels are never replaced by AI ones or by shared files. No Electron.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { HASH_MATCH_BITS, hashDistance } from './hash'

export const APP_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const labelSchema = z
  .object({
    role: z.string().min(1).max(30),
    automationId: z.string().min(1).max(200).optional(),
    iconHash: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .optional(),
    label: z.string().min(1).max(60),
    description: z.string().max(200).optional(),
    source: z.enum(['ai', 'human']),
    confidence: z.number().min(0).max(1),
    updated: z.string().max(30).optional(),
    /** Local files only: mine = made or fixed on this PC, shared = came in a `.lumen` file. */
    origin: z.enum(['mine', 'shared']).optional()
  })
  .strict()
  .refine((l) => !!l.automationId || !!l.iconHash, 'needs automationId or iconHash')

export const labelsFileSchema = z
  .object({
    $schema: z.string().optional(),
    format: z.literal(1),
    app: z.string().regex(APP_ID_RE).max(60),
    appName: z.string().max(60).optional(),
    labels: z.array(labelSchema).max(2000)
  })
  .strict()

export type LabelEntry = z.infer<typeof labelSchema>
export type LabelsFile = z.infer<typeof labelsFileSchema>

export interface LabelQuery {
  role: string
  automationId?: string
  iconHash?: string | null
}

export const labelKey = (l: {
  role: string
  automationId?: string
  iconHash?: string | null
}): string =>
  l.automationId ? `aid:${l.role}:${l.automationId}` : `icon:${l.role}:${l.iconHash ?? ''}`

/** Labels shipped in app packs (bundled or community), read-only. */
export type PackLabels = (app: string) => LabelEntry[]

export function parseLabelsFile(raw: unknown): LabelsFile | null {
  const r = labelsFileSchema.safeParse(raw)
  return r.success ? r.data : null
}

function findIn(list: LabelEntry[], q: LabelQuery): LabelEntry | null {
  if (q.automationId) {
    const hit = list.find((l) => l.role === q.role && l.automationId === q.automationId)
    if (hit) return hit
  }
  if (q.iconHash) {
    let best: { l: LabelEntry; d: number } | null = null
    for (const l of list) {
      if (!l.iconHash || l.role !== q.role) continue
      const d = hashDistance(l.iconHash, q.iconHash)
      if (d <= HASH_MATCH_BITS && (!best || d < best.d)) best = { l, d }
    }
    if (best) return best.l
  }
  return null
}

export interface AppLabelsInfo {
  app: string
  appName: string
  count: number
  human: number
}

export class LabelStore {
  private cache = new Map<string, LabelsFile>()

  constructor(
    private readonly dir: string,
    private readonly packLabels: PackLabels = () => [],
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10)
  ) {}

  private file(app: string): string | null {
    return APP_ID_RE.test(app) && app.length <= 60 ? join(this.dir, `${app}.json`) : null
  }

  private load(app: string): LabelsFile | null {
    const cached = this.cache.get(app)
    if (cached) return cached
    const file = this.file(app)
    if (!file || !existsSync(file)) return null
    try {
      const data = parseLabelsFile(JSON.parse(readFileSync(file, 'utf8')))
      if (data) this.cache.set(app, data)
      return data
    } catch {
      return null
    }
  }

  private save(data: LabelsFile): void {
    const file = this.file(data.app)
    if (!file) throw new Error(`bad app id: ${data.app}`)
    this.cache.set(data.app, data)
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(`${file}.tmp`, file)
  }

  apps(): AppLabelsInfo[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        const d = this.load(f.slice(0, -5))
        return d && d.labels.length
          ? [
              {
                app: d.app,
                appName: d.appName ?? d.app,
                count: d.labels.length,
                human: d.labels.filter((l) => l.source === 'human').length
              }
            ]
          : []
      })
  }

  /** True when there are labels on this PC or in the app's pack. */
  has(app: string): boolean {
    return !!this.load(app)?.labels.length || this.packLabels(app).length > 0
  }

  entries(app: string): LabelEntry[] {
    return this.load(app)?.labels ?? []
  }

  /** The label for a control: this PC's first, then the app pack's. */
  find(app: string, q: LabelQuery): LabelEntry | null {
    return findIn(this.entries(app), q) ?? findIn(this.packLabels(app), q)
  }

  /** Adds or replaces labels (by key). AI labels never replace human ones. */
  put(app: string, appName: string, add: LabelEntry[], origin: 'mine' | 'shared' = 'mine'): number {
    const cur = this.load(app)
    const byKey = new Map((cur?.labels ?? []).map((l) => [labelKey(l), l]))
    let n = 0
    for (const raw of add) {
      const r = labelSchema.safeParse({ ...raw, origin, updated: raw.updated ?? this.today() })
      if (!r.success) continue
      const l = r.data
      const old = byKey.get(labelKey(l))
      if (old?.source === 'human' && (l.source === 'ai' || origin === 'shared')) continue
      byKey.set(labelKey(l), l)
      n++
    }
    if (n)
      this.save({
        format: 1,
        app,
        appName: appName || cur?.appName || app,
        labels: [...byKey.values()]
      })
    return n
  }

  /** A person fixed (or confirmed) a label: it becomes human; null deletes it. */
  edit(app: string, key: string, label: string | null): boolean {
    const cur = this.load(app)
    const old = cur?.labels.find((l) => labelKey(l) === key)
    if (!cur || !old) return false
    const rest = cur.labels.filter((l) => l !== old)
    const text = label?.replace(/\s+/g, ' ').trim().slice(0, 60)
    const labels =
      label === null || !text
        ? rest
        : [
            ...rest,
            {
              ...old,
              label: text,
              source: 'human' as const,
              confidence: 1,
              origin: 'mine' as const,
              updated: this.today()
            }
          ]
    this.save({ ...cur, labels })
    return true
  }

  removeApp(app: string): boolean {
    const file = this.file(app)
    this.cache.delete(app)
    if (!file || !existsSync(file)) return false
    rmSync(file, { force: true })
    return true
  }

  /** The app's labels as a pack labels.json (no local origin marks). */
  exportFile(app: string): LabelsFile | null {
    const cur = this.load(app)
    if (!cur?.labels.length) return null
    return {
      format: 1,
      app: cur.app,
      ...(cur.appName ? { appName: cur.appName } : {}),
      labels: cur.labels.map((l) => {
        const copy = { ...l }
        delete copy.origin
        return copy
      })
    }
  }
}
