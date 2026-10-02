/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// Skill pack validation shared by the CLI (scripts/validate-skills.mjs) and the app's pack
// installer (src/main/packs): the schemas in this folder (CONTRACTS C8 skill packs, C9 lessons)
// plus the authoring rules a schema can't express: cross-file references, size caps and the
// "write for the ear" lint. Plain Node, no dependencies; types in validate.d.mts.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Folders under skills/ that are not app packs.
export const NON_PACK_DIRS = new Set(['schema', 'builtin', 'user'])

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
// Spoken lines are read aloud: links and file paths come out as noise, abbreviations as letters.
const LINK_RE = /\bhttps?:\/\/|\bwww\.\w|\b[a-z]:\\|%[a-z]+%/i
const ABBREV_RE = /\b(e\.g|i\.e|etc)\./i

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
  if (LINK_RE.test(text)) problems.push(`${kind} reads out a link or file path`)
  if (ABBREV_RE.test(text)) problems.push(`${kind} uses an abbreviation; write it out`)
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

/** The schemas in `schemaDir` (skills/schema). */
export function loadSchemas(schemaDir) {
  const load = (name) => JSON.parse(readFileSync(join(schemaDir, name), 'utf8'))
  return {
    skill: load('skill.schema.json'),
    regions: load('regions.schema.json'),
    lesson: load('lesson.schema.json'),
    curriculum: load('curriculum.schema.json'),
    bridgeKeys: load('bridge-keys.json')
  }
}

/** Problems with a bridge check's `expect` keys (skills/schema/bridge-keys.json). */
export function bridgeExpectProblems(check, bridgeKeys) {
  const spec = bridgeKeys[check.app]
  if (!spec) return [`no bridge for app "${check.app}"`]
  const keys = Object.keys(check.expect ?? {})
  if (spec.requests) {
    const allowed = spec.requests[check.expect?.request]
    if (!allowed) return [`expect.request must be one of ${Object.keys(spec.requests).join(', ')}`]
    return keys
      .filter((k) => k !== 'request' && !allowed.includes(k))
      .map((k) => `unknown ${check.app} ${check.expect.request} key "${k}"`)
  }
  return keys.filter((k) => !spec.keys.includes(k)).map((k) => `unknown ${check.app} key "${k}"`)
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
  const { file, packId, regionKeys, errors, bridgeKeys } = ctx
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
        if (c.type === 'bridge' && bridgeKeys)
          bridgeExpectProblems(c, bridgeKeys).forEach((m) => push(`${sp}.expect.check`, m))
        if (c.type === 'uia-event' && c.changed && c.event !== 'value')
          push(`${sp}.expect.check`, '"changed" works only with event "value"')
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

export function validatePack(packDir, schemas, errors, lessonIndex) {
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

  const packLessons = new Map()
  for (const name of lessonFiles) {
    const lf = join(lessonsDir, name)
    const lesson = readJson(lf, errors)
    if (lesson === undefined) continue
    validateSchema(lesson, schemas.lesson).forEach((e) => errors.push({ file: lf, ...e }))
    if (typeof lesson !== 'object' || lesson === null) continue
    validateLesson(lesson, { file: lf, packId, regionKeys, errors, bridgeKeys: schemas.bridgeKeys })
    if (typeof lesson.id === 'string')
      packLessons.set(lesson.id, Array.isArray(lesson.prereqs) ? lesson.prereqs : [])
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
  if (existsSync(file('curriculum.json')))
    validateCurriculum(file('curriculum.json'), packId, packLessons, schemas, errors)
  return lessonFiles.length
}

/**
 * curriculum.json (plans 07 T28): schema, app = folder, every pack lesson listed exactly once,
 * and each lesson after the prereqs it has in this pack.
 */
function validateCurriculum(cf, packId, packLessons, schemas, errors) {
  const c = readJson(cf, errors)
  if (c === undefined) return
  const before = errors.length
  validateSchema(c, schemas.curriculum).forEach((e) => errors.push({ file: cf, ...e }))
  if (errors.length > before || typeof c !== 'object' || c === null) return
  if (c.app !== packId)
    errors.push({ file: cf, path: '$.app', message: `must equal folder name "${packId}"` })
  const seen = new Set()
  const unitIds = new Set()
  c.units.forEach((u, ui) => {
    if (unitIds.has(u.id))
      errors.push({ file: cf, path: `$.units[${ui}].id`, message: `duplicate unit id "${u.id}"` })
    unitIds.add(u.id)
    u.lessons.forEach((id, li) => {
      const path = `$.units[${ui}].lessons[${li}]`
      if (!packLessons.has(id))
        errors.push({ file: cf, path, message: `unknown lesson id "${id}" in this pack` })
      else if (seen.has(id)) errors.push({ file: cf, path, message: `"${id}" is listed twice` })
      else
        for (const p of packLessons.get(id))
          if (packLessons.has(p) && !seen.has(p))
            errors.push({ file: cf, path, message: `"${id}" comes before its prereq "${p}"` })
      seen.add(id)
    })
  })
  for (const id of packLessons.keys())
    if (!seen.has(id))
      errors.push({ file: cf, path: '$.units', message: `lesson "${id}" is in no unit` })
}

function prereqProblems(lessonIndex, known, errors) {
  for (const [id, { file, prereqs }] of lessonIndex)
    prereqs.forEach((p, i) => {
      if (!lessonIndex.has(p) && !known.has(p))
        errors.push({ file, path: `$.prereqs[${i}]`, message: `unknown lesson id "${p}"` })
      if (p === id) errors.push({ file, path: `$.prereqs[${i}]`, message: 'lesson lists itself' })
    })
}

/**
 * Validate one pack folder on its own (an imported community pack). `knownLessonIds`: lesson
 * ids installed elsewhere that prereqs may name.
 * @returns {{file:string,path:string,message:string}[]}
 */
export function validatePackFolder(packDir, schemas, knownLessonIds = []) {
  const errors = []
  const lessonIndex = new Map()
  validatePack(packDir, schemas, errors, lessonIndex)
  prereqProblems(lessonIndex, new Set(knownLessonIds), errors)
  return errors
}

/**
 * Validate every pack folder under `skillsDir` (all folders except NON_PACK_DIRS).
 * @returns {{ errors: {file:string,path:string,message:string}[], packs: string[], lessons: number }}
 */
export function validateSkillsDir(skillsDir, schemas) {
  const errors = []
  const packs = []
  let lessons = 0
  if (!existsSync(skillsDir)) {
    errors.push({ file: skillsDir, path: '$', message: 'skills folder not found' })
    return { errors, packs, lessons }
  }
  const lessonIndex = new Map()
  for (const name of readdirSync(skillsDir).sort()) {
    const dir = join(skillsDir, name)
    if (!statSync(dir).isDirectory() || NON_PACK_DIRS.has(name) || name.startsWith('.')) continue
    packs.push(name)
    lessons += validatePack(dir, schemas, errors, lessonIndex)
  }
  prereqProblems(lessonIndex, new Set(), errors)
  return { errors, packs, lessons }
}
