// What a project is built with: dependencies from package.json (root, apps/*, packages/*),
// pyproject.toml / requirements.txt and Cargo.toml, matched against the library and a small
// catalog of well-known libraries with their docs, so Lumen can say "this project uses Next.js
// and Prisma: add skills for them?". Read-only; never runs a package manager.
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type {
  CodingSkillInfo,
  CodingSkillSuggestion,
  DetectedDependency
} from '@shared/coding-skills'

const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_SUB = 40

export interface CatalogEntry {
  /** Skill name in the library. */
  name: string
  title: string
  ecosystem: DetectedDependency['ecosystem']
  /** Package names that mean the project uses it. */
  packages: string[]
  docsUrl: string
  /** Spoken names besides the title ("next", "nextjs"). */
  aliases?: string[]
}

/** Well-known libraries: a dependency on one suggests a skill from its docs. */
export const CATALOG: CatalogEntry[] = [
  {
    name: 'nextjs',
    title: 'Next.js',
    ecosystem: 'npm',
    packages: ['next'],
    docsUrl: 'https://nextjs.org/docs',
    aliases: ['next', 'next js']
  },
  {
    name: 'better-auth',
    title: 'Better Auth',
    ecosystem: 'npm',
    packages: ['better-auth'],
    docsUrl: 'https://www.better-auth.com/docs',
    aliases: ['better auth']
  },
  {
    name: 'prisma',
    title: 'Prisma',
    ecosystem: 'npm',
    packages: ['prisma', '@prisma/client'],
    docsUrl: 'https://www.prisma.io/docs'
  },
  {
    name: 'drizzle',
    title: 'Drizzle ORM',
    ecosystem: 'npm',
    packages: ['drizzle-orm', 'drizzle-kit'],
    docsUrl: 'https://orm.drizzle.team/docs/overview',
    aliases: ['drizzle orm']
  },
  {
    name: 'tailwindcss',
    title: 'Tailwind CSS',
    ecosystem: 'npm',
    packages: ['tailwindcss'],
    docsUrl: 'https://tailwindcss.com/docs',
    aliases: ['tailwind']
  },
  {
    name: 'trpc',
    title: 'tRPC',
    ecosystem: 'npm',
    packages: ['@trpc/server', '@trpc/client'],
    docsUrl: 'https://trpc.io/docs'
  },
  {
    name: 'supabase',
    title: 'Supabase',
    ecosystem: 'npm',
    packages: ['@supabase/supabase-js', '@supabase/ssr'],
    docsUrl: 'https://supabase.com/docs'
  },
  {
    name: 'stripe',
    title: 'Stripe',
    ecosystem: 'npm',
    packages: ['stripe', '@stripe/stripe-js'],
    docsUrl: 'https://docs.stripe.com'
  },
  {
    name: 'electron',
    title: 'Electron',
    ecosystem: 'npm',
    packages: ['electron'],
    docsUrl: 'https://www.electronjs.org/docs/latest'
  },
  {
    name: 'vitest',
    title: 'Vitest',
    ecosystem: 'npm',
    packages: ['vitest'],
    docsUrl: 'https://vitest.dev/guide/'
  },
  {
    name: 'playwright',
    title: 'Playwright',
    ecosystem: 'npm',
    packages: ['@playwright/test', 'playwright'],
    docsUrl: 'https://playwright.dev/docs/intro'
  },
  {
    name: 'django',
    title: 'Django',
    ecosystem: 'pypi',
    packages: ['django'],
    docsUrl: 'https://docs.djangoproject.com/en/stable/'
  },
  {
    name: 'fastapi',
    title: 'FastAPI',
    ecosystem: 'pypi',
    packages: ['fastapi'],
    docsUrl: 'https://fastapi.tiangolo.com/',
    aliases: ['fast api']
  },
  {
    name: 'sqlalchemy',
    title: 'SQLAlchemy',
    ecosystem: 'pypi',
    packages: ['sqlalchemy'],
    docsUrl: 'https://docs.sqlalchemy.org/en/20/'
  },
  {
    name: 'pydantic',
    title: 'Pydantic',
    ecosystem: 'pypi',
    packages: ['pydantic'],
    docsUrl: 'https://docs.pydantic.dev/latest/'
  },
  {
    name: 'axum',
    title: 'Axum',
    ecosystem: 'cargo',
    packages: ['axum'],
    docsUrl: 'https://docs.rs/axum/latest/axum/'
  },
  {
    name: 'tokio',
    title: 'Tokio',
    ecosystem: 'cargo',
    packages: ['tokio'],
    docsUrl: 'https://tokio.rs/tokio/tutorial'
  },
  {
    name: 'bevy',
    title: 'Bevy',
    ecosystem: 'cargo',
    packages: ['bevy'],
    docsUrl: 'https://bevyengine.org/learn/quick-start/introduction/'
  }
]

function readSmall(file: string): string | null {
  try {
    if (!existsSync(file) || statSync(file).size > MAX_MANIFEST_BYTES) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Dependencies of one package.json text. */
export function npmDeps(text: string, file = 'package.json'): DetectedDependency[] {
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(text) as Record<string, unknown>
  } catch {
    return []
  }
  const out: DetectedDependency[] = []
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[key]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, v] of Object.entries(deps as Record<string, unknown>))
      out.push({
        ecosystem: 'npm',
        name: name.toLowerCase(),
        ...(typeof v === 'string' ? { version: v.slice(0, 40) } : {}),
        file
      })
  }
  return out
}

/** "fastapi[all]>=0.110" → { name: "fastapi", version: ">=0.110" } (PEP 508, loosely). */
function pep508(spec: string): { name: string; version?: string } | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~][^;]*)?/.exec(spec)
  if (!m) return null
  const name = m[1].toLowerCase().replace(/_/g, '-')
  return { name, ...(m[2]?.trim() ? { version: m[2].trim().slice(0, 40) } : {}) }
}

/** pyproject.toml: [project] dependencies = [...] and [tool.poetry.dependencies] keys. */
export function pyprojectDeps(text: string, file = 'pyproject.toml'): DetectedDependency[] {
  const out: DetectedDependency[] = []
  const start = /^\s*dependencies\s*=\s*\[/m.exec(text)
  if (start)
    for (const s of quotedUntilClose(text.slice(start.index + start[0].length))) {
      const d = pep508(s)
      if (d) out.push({ ecosystem: 'pypi', ...d, file })
    }
  for (const section of tomlSections(
    text,
    /^tool\.poetry\.(?:dev-)?dependencies$|^tool\.poetry\.group\.[\w-]+\.dependencies$/
  ))
    for (const [k, v] of section)
      if (k.toLowerCase() !== 'python')
        out.push({ ecosystem: 'pypi', name: k.toLowerCase(), ...(v ? { version: v } : {}), file })
  return out
}

/** The quoted strings of a TOML array body, up to its closing ] outside quotes. */
function quotedUntilClose(src: string): string[] {
  const out: string[] = []
  let q = ''
  let cur = ''
  for (const ch of src) {
    if (q) {
      if (ch === q) {
        out.push(cur)
        q = ''
        cur = ''
      } else cur += ch
    } else if (ch === '"' || ch === "'") q = ch
    else if (ch === ']') break
  }
  return out
}

export function requirementsDeps(text: string, file = 'requirements.txt'): DetectedDependency[] {
  const out: DetectedDependency[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/#.*/, '').trim()
    if (!t || t.startsWith('-')) continue
    const d = pep508(t)
    if (d) out.push({ ecosystem: 'pypi', ...d, file })
  }
  return out
}

/** Cargo.toml: [dependencies], [dev-dependencies], [workspace.dependencies]. */
export function cargoDeps(text: string, file = 'Cargo.toml'): DetectedDependency[] {
  const out: DetectedDependency[] = []
  for (const section of tomlSections(text, /^(?:workspace\.)?(?:dev-|build-)?dependencies$/))
    for (const [k, v] of section)
      out.push({ ecosystem: 'cargo', name: k.toLowerCase(), ...(v ? { version: v } : {}), file })
  return out
}

/** key → version string of every `[name]` table whose name matches. */
function tomlSections(text: string, re: RegExp): [string, string | undefined][][] {
  const out: [string, string | undefined][][] = []
  let cur: [string, string | undefined][] | null = null
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (head) {
      cur = re.test(head[1].trim()) ? [] : null
      if (cur) out.push(cur)
      continue
    }
    if (!cur) continue
    const kv = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    const v = kv[2].trim()
    const version =
      /^["']([^"']*)["']/.exec(v)?.[1] ?? /version\s*=\s*["']([^"']*)["']/.exec(v)?.[1]
    cur.push([kv[1].replace(/^["']|["']$/g, ''), version?.slice(0, 40)])
  }
  return out
}

function subPackages(project: string): string[] {
  const out: string[] = []
  for (const group of ['apps', 'packages']) {
    const dir = join(project, group)
    try {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir).slice(0, MAX_SUB))
        if (!name.startsWith('.') && name !== 'node_modules')
          out.push(`${group}/${name}/package.json`)
    } catch {
      /* unreadable */
    }
  }
  return out
}

/** Every dependency the project declares (deduplicated by ecosystem + name). */
export function detectDependencies(project: string): DetectedDependency[] {
  const found: DetectedDependency[] = []
  for (const rel of ['package.json', ...subPackages(project)]) {
    const t = readSmall(join(project, rel))
    if (t) found.push(...npmDeps(t, rel))
  }
  const py = readSmall(join(project, 'pyproject.toml'))
  if (py) found.push(...pyprojectDeps(py))
  const req = readSmall(join(project, 'requirements.txt'))
  if (req) found.push(...requirementsDeps(req))
  const cargo = readSmall(join(project, 'Cargo.toml'))
  if (cargo) found.push(...cargoDeps(cargo))
  const seen = new Set<string>()
  return found.filter((d) => {
    const k = `${d.ecosystem}:${d.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function reasonFor(d: DetectedDependency): string {
  return `${d.name}${d.version ? ` ${d.version}` : ''} in ${d.file}`
}

/**
 * Skills worth attaching: library skills whose packages the project uses, then catalog
 * libraries the project uses that have no skill yet. Attached ones are left out.
 */
export function suggestSkills(
  deps: DetectedDependency[],
  library: CodingSkillInfo[],
  attached: string[],
  catalog: CatalogEntry[] = CATALOG
): CodingSkillSuggestion[] {
  const out: CodingSkillSuggestion[] = []
  const used = new Set(attached)
  const byName = new Map(deps.map((d) => [d.name, d]))
  // Packages a library skill already covers (attached or not) need no catalog suggestion.
  const covered = new Set(library.flatMap((s) => s.packages.map((p) => p.toLowerCase())))
  for (const s of library) {
    if (used.has(s.name)) continue
    const hit = s.packages.map((p) => byName.get(p.toLowerCase())).find(Boolean)
    if (!hit) continue
    used.add(s.name)
    out.push({ name: s.name, title: s.title, reason: reasonFor(hit), inLibrary: true })
  }
  const inLibrary = new Set(library.map((s) => s.name))
  for (const c of catalog) {
    if (used.has(c.name) || inLibrary.has(c.name)) continue
    const hit = deps.find(
      (d) => d.ecosystem === c.ecosystem && c.packages.includes(d.name) && !covered.has(d.name)
    )
    if (!hit) continue
    used.add(c.name)
    out.push({
      name: c.name,
      title: c.title,
      reason: reasonFor(hit),
      inLibrary: false,
      docsUrl: c.docsUrl
    })
  }
  return out
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** "Next.js" / "next js" / "nextjs" → the catalog entry. */
export function catalogFor(spoken: string, catalog: CatalogEntry[] = CATALOG): CatalogEntry | null {
  const said = norm(spoken)
  const joined = said.replace(/\s/g, '')
  if (!said) return null
  for (const c of catalog) {
    const names = [c.name, c.title, ...(c.aliases ?? []), ...c.packages].map(norm)
    if (names.some((n) => n === said || n.replace(/\s/g, '') === joined)) return c
  }
  return null
}
