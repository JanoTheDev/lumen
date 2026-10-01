// The SKILL.md frontmatter schema (CONTRACTS C10 + C10 v2). Permissions are strict: an
// unknown permission key fails the skill, so a typo can never be read as "not asked for".
// Other unknown top-level keys only warn (forward compatible). No Electron.
import { z } from 'zod'
import type { SkillManifest } from '@shared/types'
import { splitFrontmatter } from './frontmatter'

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SKILL_FILE = 'SKILL.md'
/** A SKILL.md larger than this is refused. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024
/** The loader warns when a body is longer than this (Claude's guidance: keep it short). */
export const BODY_WARN_TOKENS = 5000

const kebab = z.string().regex(SKILL_NAME_RE, 'use lowercase words joined by "-"')
const short = (max: number): z.ZodString => z.string().trim().min(1).max(max)

/** "https://*.youtube.com" or "https://example.com/path"; http(s) only. */
const urlPattern = z
  .string()
  .regex(/^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?(\/\S*)?$/i, 'expected an https:// address pattern')

const pathEntry = z.string().trim().min(1).max(260)

export const permissionsSchema = z
  .object({
    input: z.boolean().default(false),
    network: z.array(urlPattern).max(20).default([]),
    files: z
      .object({
        read: z.array(pathEntry).max(20).default([]),
        write: z.array(pathEntry).max(20).default([])
      })
      .strict()
      .default({ read: [], write: [] }),
    connectors: z.array(kebab).max(20).default([]),
    profile: z.boolean().default(false),
    risky: z.boolean().default(false),
    screen: z.boolean().default(false)
  })
  .strict()

const paramSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean']).default('string'),
    default: z.union([z.string().max(200), z.number(), z.boolean()]).optional(),
    description: short(200).optional(),
    enum: z
      .array(z.union([z.string().max(80), z.number()]))
      .min(1)
      .max(30)
      .optional()
  })
  .strict()

const KNOWN_KEYS = [
  'name',
  'description',
  'when_to_use',
  'version',
  'author',
  'license',
  'apps',
  'triggers',
  'params',
  'permissions',
  'context',
  'model',
  'tools',
  'kind',
  'levels'
] as const

export const manifestSchema = z.object({
  name: kebab.max(64),
  description: short(200),
  when_to_use: short(200).optional(),
  version: z
    .union([z.string(), z.number()])
    .transform(String)
    .pipe(z.string().regex(/^\d+(\.\d+){0,2}([-+][\w.]+)?$/, 'expected a version like 1.0.0'))
    .default('1.0.0'),
  author: short(80).optional(),
  license: short(80).optional(),
  apps: z.array(kebab).max(20).default([]),
  triggers: z.array(z.string().trim().min(2).max(80)).max(20).default([]),
  params: z
    .record(
      z.string().regex(/^[A-Za-z_]\w{0,31}$/, 'param names are letters, digits, _'),
      paramSchema
    )
    .refine((r) => Object.keys(r).length <= 20, 'at most 20 params')
    .default({}),
  permissions: permissionsSchema.default(permissionsSchema.parse({})),
  context: z.enum(['foreground', 'background']).default('foreground'),
  model: z.enum(['fast', 'main', 'planning']).optional(),
  tools: z
    .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
    .max(40)
    .optional(),
  /** "style": a reply style (ai/style.ts reads its `levels` and body). */
  kind: z.enum(['task', 'style']).optional()
})

export interface ParsedSkillFile {
  manifest: SkillManifest
  body: string
  warnings: string[]
}

export class SkillFileError extends Error {}

/** Rough token count, the same ratio the prompt builder uses. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || 'header'}: ${i.message}`)
    .join('; ')
}

/** Parses a whole SKILL.md. Throws SkillFileError with a readable reason. */
export function parseSkillFile(text: string): ParsedSkillFile {
  let split: ReturnType<typeof splitFrontmatter>
  try {
    split = splitFrontmatter(text)
  } catch (e) {
    throw new SkillFileError((e as Error).message)
  }
  const r = manifestSchema.safeParse(split.data)
  if (!r.success) throw new SkillFileError(zodMessage(r.error))
  const warnings: string[] = []
  const unknown = Object.keys(split.data).filter(
    (k) => !(KNOWN_KEYS as readonly string[]).includes(k)
  )
  if (unknown.length) warnings.push(`unknown header keys ignored: ${unknown.join(', ')}`)
  if (!split.body) warnings.push('the instructions are empty')
  const tokens = estimateTokens(split.body)
  if (tokens > BODY_WARN_TOKENS)
    warnings.push(
      `the instructions are long (~${tokens} tokens); move details into reference/ files`
    )
  const m = r.data
  const manifest: SkillManifest = {
    name: m.name,
    description: m.description,
    ...(m.when_to_use ? { when_to_use: m.when_to_use } : {}),
    version: m.version,
    ...(m.author ? { author: m.author } : {}),
    ...(m.license ? { license: m.license } : {}),
    apps: m.apps,
    triggers: m.triggers,
    params: m.params,
    permissions: m.permissions,
    context: m.context,
    ...(m.model ? { model: m.model } : {}),
    ...(m.tools ? { tools: m.tools } : {}),
    ...(m.kind === 'style' ? { kind: 'style' as const } : {})
  }
  return { manifest, body: split.body, warnings }
}

/** A fresh SKILL.md for "New skill" in Settings. */
export function skillTemplate(name: string, description: string): string {
  return `---
name: ${name}
description: ${JSON.stringify(description)}
version: 1.0.0
triggers: []
permissions:
  input: false
---
Write short, numbered steps for what Lumen should do.
`
}
