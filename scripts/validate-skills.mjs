/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// Validates every skill pack under skills/ against the schemas in skills/schema
// (CONTRACTS C8 skill packs, C9 lessons) plus the authoring rules that a schema
// can't express: cross-file references, size caps and the "write for the ear" lint.
//
// Usage: node scripts/validate-skills.mjs [skillsDir]
// Exit code 0 when every pack is valid, 1 otherwise. One line per problem:
//   <file>: <json path>: <message>

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SKILLS_DIR = resolve(HERE, '..', 'skills')

// Folders under skills/ that are not app packs.
const NON_PACK_DIRS = new Set(['schema', 'builtin', 'user'])

export const LIMITS = {
  overviewTokens: 1500,
  shortcutsTokens: 3000,
  glossaryTokens: 3000,
  sayWords: 25,
  hintWords: 40,
  whyWords: 30
}

const REQUIRED_FILES = [
  'skill.json',
  'overview.md',
  'shortcuts.md',
  'regions.json',
  'glossary.md',
  'SOURCES.md'
]

const BANNED_WORDS = ['simply', 'just', 'obviously', 'easy', 'easily']

/** Rough token estimate used across the repo for budget checks. */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema interpreter (the subset our schemas use).

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

function typeMatches(v, t) {
  const actual = typeOf(v)
  if (t === 'number') return actual === 'number' || actual === 'integer'
  return actual === t
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`)
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => node[key], root)
}

function joinPath(base, key) {
  return typeof key === 'number' ? `${base}[${key}]` : `${base}.${key}`
}

/** Pick the oneOf branch whose `const` discriminator matches, so errors stay readable. */
function discriminatedBranch(value, branches, root) {
  if (typeOf(value) !== 'object') return null
  const hits = branches
    .map((b) => (b.$ref ? resolveRef(b.$ref, root) : b))
    .filter((b) => {
      const props = b.properties ?? {}
      const consts = Object.entries(props).filter(([, p]) => 'const' in p || 'enum' in p)
      return (
        consts.length > 0 &&
        consts.every(([k, p]) => ('const' in p ? value[k] === p.const : p.enum.includes(value[k])))
      )
    })
  return hits.length === 1 ? hits[0] : null
}

export function validateSchema(value, schema, root = schema, path = '$') {
  if (schema.$ref) return validateSchema(value, resolveRef(schema.$ref, root), root, path)
  const errors = []
  const err = (msg) => errors.push({ path, message: msg })

  if (schema.oneOf) {
    const results = schema.oneOf.map((b) => validateSchema(value, b, root, path))
    const passing = results.filter((r) => r.length === 0).length
    if (passing === 1) return errors
    if (passing > 1) {
      err('matches more than one allowed shape')
      return errors
    }
    const branch = discriminatedBranch(value, schema.oneOf, root)
    if (branch) return validateSchema(value, branch, root, path)
    const keys = typeOf(value) === 'object' ? Object.keys(value).join(', ') : typeOf(value)
    err(`does not match any allowed shape (got ${keys || 'empty object'})`)
    return errors
  }

  if ('const' in schema && value !== schema.const) {
    err(`must be ${JSON.stringify(schema.const)}`)
    return errors
  }
  if (schema.enum && !schema.enum.includes(value)) {
    err(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)
    return errors
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => typeMatches(value, t))) {
      err(`must be ${types.join(' or ')}, got ${typeOf(value)}`)
      return errors
    }
  }

  const t = typeOf(value)
  if (t === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      err(`must be at least ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      err(`must be at most ${schema.maxLength} characters (has ${value.length})`)
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
      err(`must match /${schema.pattern}/`)
  }
  if (t === 'number' || t === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`must be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) err(`must be <= ${schema.maximum}`)
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      err(`must be > ${schema.exclusiveMinimum}`)
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      err(`must have at least ${schema.minItems} items (has ${value.length})`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      err(`must have at most ${schema.maxItems} items (has ${value.length})`)
    if (schema.items)
      value.forEach((item, i) =>
        errors.push(...validateSchema(item, schema.items, root, joinPath(path, i)))
      )
  }
  if (t === 'object') {
    const keys = Object.keys(value)
    if (schema.minProperties !== undefined && keys.length < schema.minProperties)
      err(`must have at least ${schema.minProperties} properties`)
    for (const req of schema.required ?? [])
      if (!(req in value)) err(`missing required property "${req}"`)
    const props = schema.properties ?? {}
    for (const key of keys) {
      const sub = joinPath(path, key)
      if (schema.propertyNames?.pattern && !new RegExp(schema.propertyNames.pattern).test(key))
        errors.push({ path: sub, message: `key must match /${schema.propertyNames.pattern}/` })
      if (key in props) errors.push(...validateSchema(value[key], props[key], root, sub))
      else if (schema.additionalProperties === false)
        errors.push({ path: sub, message: 'unknown property' })
      else if (typeof schema.additionalProperties === 'object')
        errors.push(...validateSchema(value[key], schema.additionalProperties, root, sub))
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// Ear lint (skill-pack-authoring.md "Writing say").

const EMOJI_RE = /\p{Extended_Pictographic}/u
const SYMBOL_SHORTCUT_RE = /\b(ctrl|alt|shift|win|cmd|control)\s*\+|\+\s*[a-z0-9]\b/i
const COORD_RE =
  /\b\d{2,5}\s*(px|pixels?)\b|\(\s*\d{2,5}\s*,\s*\d{2,5}\s*\)|\bx\s*=\s*\d|\by\s*=\s*\d/i
const MARKDOWN_RE = /\*\*|`|\|.*\||^\s*#|^\s*[-*]\s|\[[^\]]+\]\([^)]+\)/m

function lintSpoken(text, kind, maxWords) {
  const problems = []
  const words = wordCount(text)
  if (words > maxWords) problems.push(`${kind} has ${words} words, max ${maxWords}`)
  for (const w of BANNED_WORDS)
    if (new RegExp(`\\b${w}\\b`, 'i').test(text)) problems.push(`${kind} uses "${w}"`)
  if (text.includes('!')) problems.push(`${kind} has an exclamation mark`)
  if (EMOJI_RE.test(text)) problems.push(`${kind} has an emoji`)
  if (SYMBOL_SHORTCUT_RE.test(text))
    problems.push(`${kind} writes a shortcut with "+"; spell it out ("Control Shift A")`)
  if (COORD_RE.test(text)) problems.push(`${kind} mentions raw coordinates`)
  if (MARKDOWN_RE.test(text)) problems.push(`${kind} contains markdown`)
  return problems
}

// ---------------------------------------------------------------------------

function readJson(file, errors) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    errors.push({ file, path: '$', message: `invalid JSON: ${e.message}` })
    return undefined
  }
}

function loadSchemas(skillsDir) {
  const dir = join(skillsDir, 'schema')
  const fallback = join(DEFAULT_SKILLS_DIR, 'schema')
  const pick = (name) => (existsSync(join(dir, name)) ? join(dir, name) : join(fallback, name))
  const load = (name) => JSON.parse(readFileSync(pick(name), 'utf8'))
  return {
    skill: load('skill.schema.json'),
    regions: load('regions.schema.json'),
    lesson: load('lesson.schema.json')
  }
}

function collectChecks(check, out = []) {
  if (check && typeof check === 'object') {
    out.push(check)
    if (Array.isArray(check.checks)) check.checks.forEach((c) => collectChecks(c, out))
  }
  return out
}

function validateRegionsGeometry(regions, file, errors) {
  const EPS = 1e-9
  for (const [key, r] of Object.entries(regions?.regions ?? {})) {
    if (typeof r !== 'object' || r === null) continue
    if (r.x + r.w > 1 + EPS)
      errors.push({ file, path: `$.regions.${key}`, message: 'x + w must be <= 1' })
    if (r.y + r.h > 1 + EPS)
      errors.push({ file, path: `$.regions.${key}`, message: 'y + h must be <= 1' })
  }
}

function validateLesson(lesson, ctx) {
  const { file, packId, regionKeys, errors } = ctx
  const push = (path, message) => errors.push({ file, path, message })

  const expectedName = `${lesson.id}.lesson.json`
  if (!file.endsWith(expectedName)) push('$.id', `file name must be ${expectedName}`)
  if (lesson.app !== packId) push('$.app', `must be "${packId}" (the pack id)`)
  if (typeof lesson.id === 'string' && !lesson.id.startsWith(`${packId}-`))
    push('$.id', `must start with "${packId}-"`)

  const stepIds = new Set()
  ;(lesson.steps ?? []).forEach((step, i) => {
    const sp = `$.steps[${i}]`
    if (!step || typeof step !== 'object') return
    if (step.id) {
      if (stepIds.has(step.id)) push(`${sp}.id`, `duplicate step id "${step.id}"`)
      stepIds.add(step.id)
    }
    if (typeof step.say === 'string')
      lintSpoken(step.say, 'say', LIMITS.sayWords).forEach((m) => push(`${sp}.say`, m))
    ;(step.hints ?? []).forEach((h, j) => {
      if (typeof h !== 'string') return
      lintSpoken(h, 'hint', LIMITS.hintWords).forEach((m) => push(`${sp}.hints[${j}]`, m))
      if (h.trim().toLowerCase() === String(step.say).trim().toLowerCase())
        push(`${sp}.hints[${j}]`, 'hint only repeats the step')
    })
    if (typeof step.why === 'string')
      lintSpoken(step.why, 'why', LIMITS.whyWords).forEach((m) => push(`${sp}.why`, m))

    const region = step.target?.region
    if (region !== undefined && !regionKeys.has(region))
      push(`${sp}.target.region`, `unknown region "${region}" (not in regions.json)`)
    ;(step.doItForMe?.actions ?? []).forEach((a, j) => {
      if (a?.region !== undefined && !regionKeys.has(a.region))
        push(`${sp}.doItForMe.actions[${j}].region`, `unknown region "${a.region}"`)
    })

    const expect = step.expect
    if (expect && typeof expect === 'object') {
      if (expect.check === 'vision' && !expect.prompt)
        push(`${sp}.expect.prompt`, 'a vision check needs a specific yes/no prompt')
      for (const c of collectChecks(expect.check)) {
        if (c.type === 'window-title' || (c.type === 'uia-event' && c.match?.value?.regex)) {
          const source = c.type === 'window-title' ? c.regex : c.match.value.regex
          try {
            new RegExp(source)
          } catch {
            push(`${sp}.expect.check`, `invalid regex ${JSON.stringify(source)}`)
          }
        }
      }
    }
  })
}

function validatePack(packDir, schemas, errors, lessonIndex) {
  const packId = packDir.split(/[\\/]/).pop()
  const file = (name) => join(packDir, name)

  for (const name of REQUIRED_FILES)
    if (!existsSync(file(name)))
      errors.push({ file: file(name), path: '$', message: 'required file is missing' })

  const skill = existsSync(file('skill.json')) ? readJson(file('skill.json'), errors) : undefined
  if (skill !== undefined) {
    validateSchema(skill, schemas.skill).forEach((e) =>
      errors.push({ file: file('skill.json'), ...e })
    )
    if (skill.id !== packId)
      errors.push({
        file: file('skill.json'),
        path: '$.id',
        message: `must equal folder name "${packId}"`
      })
    const m = skill.match ?? {}
    if (![m.process, m.title, m.url].some((list) => Array.isArray(list) && list.length > 0))
      errors.push({
        file: file('skill.json'),
        path: '$.match',
        message: 'needs at least one process, title or url rule'
      })
  }

  const caps = [
    ['overview.md', LIMITS.overviewTokens],
    ['shortcuts.md', LIMITS.shortcutsTokens],
    ['glossary.md', LIMITS.glossaryTokens]
  ]
  for (const [name, cap] of caps) {
    if (!existsSync(file(name))) continue
    const tokens = estimateTokens(readFileSync(file(name), 'utf8'))
    if (tokens > cap)
      errors.push({ file: file(name), path: '$', message: `about ${tokens} tokens, max ${cap}` })
  }
  if (existsSync(file('shortcuts.md'))) {
    const text = readFileSync(file('shortcuts.md'), 'utf8')
    if (!/^\|\s*Action\s*\|\s*Shortcut\s*\|/im.test(text))
      errors.push({
        file: file('shortcuts.md'),
        path: '$',
        message: 'needs a table with columns Action | Shortcut | Mode/context'
      })
  }

  let regionKeys = new Set()
  if (existsSync(file('regions.json'))) {
    const regions = readJson(file('regions.json'), errors)
    if (regions !== undefined) {
      validateSchema(regions, schemas.regions).forEach((e) =>
        errors.push({ file: file('regions.json'), ...e })
      )
      validateRegionsGeometry(regions, file('regions.json'), errors)
      regionKeys = new Set(Object.keys(regions.regions ?? {}))
    }
  }

  const lessonsDir = file('lessons')
  const lessonFiles = existsSync(lessonsDir)
    ? readdirSync(lessonsDir).filter((n) => n.endsWith('.lesson.json'))
    : []
  if (lessonFiles.length === 0)
    errors.push({ file: lessonsDir, path: '$', message: 'pack has no lessons/*.lesson.json' })
  for (const n of existsSync(lessonsDir) ? readdirSync(lessonsDir) : [])
    if (!n.endsWith('.lesson.json'))
      errors.push({ file: join(lessonsDir, n), path: '$', message: 'unexpected file in lessons/' })

  for (const name of lessonFiles) {
    const lf = join(lessonsDir, name)
    const lesson = readJson(lf, errors)
    if (lesson === undefined) continue
    validateSchema(lesson, schemas.lesson).forEach((e) => errors.push({ file: lf, ...e }))
    if (typeof lesson !== 'object' || lesson === null) continue
    validateLesson(lesson, { file: lf, packId, regionKeys, errors })
    if (typeof lesson.id === 'string') {
      if (lessonIndex.has(lesson.id))
        errors.push({
          file: lf,
          path: '$.id',
          message: `duplicate lesson id (also in ${lessonIndex.get(lesson.id).file})`
        })
      else lessonIndex.set(lesson.id, { file: lf, prereqs: lesson.prereqs ?? [] })
    }
  }
  return lessonFiles.length
}

/**
 * Validate every pack folder under `skillsDir` (all folders except NON_PACK_DIRS).
 * @returns {{ errors: {file:string,path:string,message:string}[], packs: string[], lessons: number }}
 */
export function validateSkills(skillsDir = DEFAULT_SKILLS_DIR) {
  const errors = []
  const packs = []
  let lessons = 0
  if (!existsSync(skillsDir)) {
    errors.push({ file: skillsDir, path: '$', message: 'skills folder not found' })
    return { errors, packs, lessons }
  }
  const schemas = loadSchemas(skillsDir)
  const lessonIndex = new Map()
  for (const name of readdirSync(skillsDir).sort()) {
    const dir = join(skillsDir, name)
    if (!statSync(dir).isDirectory() || NON_PACK_DIRS.has(name) || name.startsWith('.')) continue
    packs.push(name)
    lessons += validatePack(dir, schemas, errors, lessonIndex)
  }
  for (const [id, { file, prereqs }] of lessonIndex)
    prereqs.forEach((p, i) => {
      if (!lessonIndex.has(p))
        errors.push({ file, path: `$.prereqs[${i}]`, message: `unknown lesson id "${p}"` })
      if (p === id) errors.push({ file, path: `$.prereqs[${i}]`, message: 'lesson lists itself' })
    })
  return { errors, packs, lessons }
}

export function formatError(e, base = process.cwd()) {
  return `${relative(base, e.file).replace(/\\/g, '/')}: ${e.path}: ${e.message}`
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SKILLS_DIR
  const { errors, packs, lessons } = validateSkills(dir)
  for (const e of errors) console.error(formatError(e))
  if (errors.length > 0) {
    console.error(`\n${errors.length} problem(s) in ${packs.length} pack(s)`)
    process.exit(1)
  }
  console.log(`ok: ${packs.length} pack(s), ${lessons} lesson(s)`)
}
