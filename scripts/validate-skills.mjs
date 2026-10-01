/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, no type annotations */
// Validates every skill pack under skills/ (or one pack folder with --pack) against the schemas
// in skills/schema. The rules live in skills/schema/validate.mjs, shared with the app's pack
// installer.
//
// Usage: node scripts/validate-skills.mjs [skillsDir]
//        node scripts/validate-skills.mjs --pack <packDir>
// Exit code 0 when every pack is valid, 1 otherwise. One line per problem:
//   <file>: <json path>: <message>

import { existsSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadSchemas, validatePackFolder, validateSkillsDir } from '../skills/schema/validate.mjs'

export {
  LIMITS,
  bridgeExpectProblems,
  estimateTokens,
  validateSchema
} from '../skills/schema/validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SKILLS_DIR = resolve(HERE, '..', 'skills')
const DEFAULT_SCHEMA_DIR = join(DEFAULT_SKILLS_DIR, 'schema')

/** A skills folder's own schema/ when it has one, else the repo's. */
function schemasFor(skillsDir) {
  const own = join(skillsDir, 'schema')
  return loadSchemas(existsSync(join(own, 'skill.schema.json')) ? own : DEFAULT_SCHEMA_DIR)
}

/**
 * Validate every pack folder under `skillsDir`.
 * @returns {{ errors: {file:string,path:string,message:string}[], packs: string[], lessons: number }}
 */
export function validateSkills(skillsDir = DEFAULT_SKILLS_DIR) {
  if (!existsSync(skillsDir))
    return {
      errors: [{ file: skillsDir, path: '$', message: 'skills folder not found' }],
      packs: [],
      lessons: 0
    }
  return validateSkillsDir(skillsDir, schemasFor(skillsDir))
}

export function formatError(e, base = process.cwd()) {
  return `${relative(base, e.file).replace(/\\/g, '/')}: ${e.path}: ${e.message}`
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  if (process.argv[2] === '--pack') {
    const dir = resolve(process.argv[3] ?? '.')
    const errors = validatePackFolder(dir, loadSchemas(DEFAULT_SCHEMA_DIR))
    for (const e of errors) console.error(formatError(e))
    if (errors.length > 0) {
      console.error(`
${errors.length} problem(s)`)
      process.exit(1)
    }
    console.log('ok: pack is valid')
  } else {
    const dir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SKILLS_DIR
    const { errors, packs, lessons } = validateSkills(dir)
    for (const e of errors) console.error(formatError(e))
    if (errors.length > 0) {
      console.error(`
${errors.length} problem(s) in ${packs.length} pack(s)`)
      process.exit(1)
    }
    console.log(`ok: ${packs.length} pack(s), ${lessons} lesson(s)`)
  }
}
