// "About you" (PROFILE.md) and per-app facts (apps/<app-id>.md).
import { FactFile, type Fact, type FactSource, type MemoryStore, type UpsertResult } from './store'

/** Profile sections in injection priority order (first = kept longest when trimming). */
export const PROFILE_SECTIONS = [
  'Access needs',
  'Name',
  'Preferences',
  'Goals',
  'Skills',
  'Other'
] as const

export type ProfileSection = (typeof PROFILE_SECTIONS)[number]

const SECTION_HINTS: [ProfileSection, RegExp][] = [
  [
    'Access needs',
    /\b(dwell|low vision|blind|screen ?reader|tremor|hearing|deaf|dyslexi|slower speech|large (?:text|font)|left[- ]handed|one hand|switch access|color ?blind|zoom)\b/i
  ],
  ['Name', /\b(my name|call me|name is|address me|pronouns?)\b/i],
  ['Goals', /\b(learning|goal|want to|trying to|working towards|plan to)\b/i],
  ['Skills', /\b(beginner|intermediate|expert|advanced|new to|experienced)\b/i],
  ['Preferences', /\b(prefer|like|dislike|rather|short answers|reading level|always|never)\b/i]
]

export function classifyProfileFact(text: string): ProfileSection {
  return SECTION_HINTS.find(([, re]) => re.test(text))?.[0] ?? 'Other'
}

export const sectionRank = (section: string): number => {
  const i = PROFILE_SECTIONS.indexOf(section as ProfileSection)
  return i < 0 ? PROFILE_SECTIONS.length : i
}

export interface AddFactInput {
  text: string
  section?: string
  source?: FactSource
  replaces?: string
}

export class ProfileLayer {
  readonly file: FactFile

  constructor(store: MemoryStore) {
    this.file = new FactFile(store, 'PROFILE.md', 'About you', PROFILE_SECTIONS)
  }

  /** Facts sorted by section priority, preserving file order inside a section. */
  facts(): Fact[] {
    return this.file
      .read()
      .map((f, i) => ({ f, i }))
      .sort((a, b) => sectionRank(a.f.section) - sectionRank(b.f.section) || a.i - b.i)
      .map(({ f }) => f)
  }

  add(input: AddFactInput): UpsertResult {
    return this.file.upsert({ ...input, section: input.section ?? classifyProfileFact(input.text) })
  }
}

export const appIdOf = (app: string): string =>
  app
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown'

export class AppLayer {
  constructor(private readonly store: MemoryStore) {}

  private file(app: string): FactFile {
    const id = appIdOf(app)
    return new FactFile(this.store, `apps/${id}.md`, id, ['Notes'])
  }

  ids(): string[] {
    return this.store
      .list('apps')
      .filter((f) => f.endsWith('.md') && !f.endsWith('.history.md'))
      .map((f) => f.slice(0, -3))
  }

  facts(app: string): Fact[] {
    return this.file(app).read()
  }

  add(app: string, input: AddFactInput): UpsertResult {
    return this.file(app).upsert({ ...input, section: input.section ?? 'Notes' })
  }

  remove(app: string, pred: (f: Fact) => boolean): Fact[] {
    return this.file(app).remove(pred)
  }
}
