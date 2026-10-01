// "Make a style that talks like a pirate": the skill writer (skills/compose authorSkill with
// kind "style") writes the words of a new reply style, which waits as a draft for the same voice review as skill drafts (skills/authoring
// matchDraftCommand: "save it", "call it …", "read it back", "discard it"). A saved style is the
// user's own `kind: style` skill in ~/.ai-overlay/skills. No Electron.
import { freeName, matchDraftCommand, slugName } from '../skills/authoring'
import { STYLE_MAX_CHARS, cleanStyleText } from './style'

/** A draft waits this long for its review. */
export const STYLE_DRAFT_MS = 10 * 60_000
/** A bare "yes" only counts this soon after the draft was offered. */
export const STYLE_YES_MS = 2 * 60_000

/** The words of a style: the skill writer's draft (skills/compose authorSkill, kind style). */
export interface StyleWords {
  name: string
  description: string
  instructions: string
}

export interface StyleDraft {
  name: string
  description: string
  instructions: string
  at: number
}

const oneLine = (s: string, max: number): string =>
  s.replace(/\s+/g, ' ').replace(/[<>]/g, ' ').trim().slice(0, max)

/** A draft from the model's words, or plain words when there are none. */
export function styleDraft(
  like: string,
  words: StyleWords | null,
  taken: (name: string) => boolean,
  now: number
): StyleDraft {
  const plain = oneLine(like, 120)
  const base = slugName(words?.name || plain, 30) || 'my-style'
  const instructions = cleanStyleText(
    (words?.instructions ?? '')
      .split('\n')
      .filter((l) => !/^\s*(?:---|#{1,6}\s)/.test(l))
      .join('\n'),
    STYLE_MAX_CHARS
  )
  return {
    name: freeName(base, taken),
    description: oneLine(words?.description || `Talks like ${plain}.`, 160),
    instructions:
      instructions ||
      `Word replies the way ${plain} would talk.\nKeep facts, numbers, names, steps and warnings exact and clear.`,
    at: now
  }
}

/** The SKILL.md of a style draft. */
export function renderStyleMd(
  d: Pick<StyleDraft, 'name' | 'description' | 'instructions'>
): string {
  return `---
name: ${d.name}
description: ${JSON.stringify(d.description)}
kind: style
version: 1.0.0
---
${d.instructions.trim()}
`
}

const MAKE_DONE = (name: string): string =>
  `Here is a style called ${name.replace(/-/g, ' ')}. Say "read it back", "call it" and a new name, "save it", or "discard it".`

export interface StyleMakerDeps {
  now(): number
  words(like: string): Promise<StyleWords | null>
  taken(name: string): boolean
  save(name: string, skillMd: string): { ok: true } | { ok: false; error: string }
}

export interface StyleMaker {
  /** Starts a draft; resolves to the line to say. */
  make(like: string): Promise<string>
  /** Review commands while a draft waits; null = not for us. */
  review(utterance: string): string | null
  draft(): StyleDraft | null
}

export function createStyleMaker(deps: StyleMakerDeps): StyleMaker {
  let draft: StyleDraft | null = null
  const live = (): StyleDraft | null => {
    if (draft && deps.now() - draft.at > STYLE_DRAFT_MS) draft = null
    return draft
  }
  return {
    async make(like) {
      let words: StyleWords | null = null
      try {
        words = await deps.words(like)
      } catch {
        words = null
      }
      draft = styleDraft(like, words, deps.taken, deps.now())
      return MAKE_DONE(draft.name)
    },
    review(utterance) {
      const d = live()
      if (!d) return null
      const c = matchDraftCommand(utterance)
      if (!c) return null
      switch (c.cmd) {
        case 'yes':
          if (deps.now() - d.at > STYLE_YES_MS) return null
        // falls through
        case 'save': {
          if (c.cmd === 'save' && c.name) {
            const n = slugName(c.name, 30)
            if (n) d.name = freeName(n, deps.taken)
          }
          const r = deps.save(d.name, renderStyleMd(d))
          if (!r.ok) return `I could not save it: ${r.error}`
          draft = null
          return `Saved. Say "turn on ${d.name.replace(/-/g, ' ')} mode" to use it.`
        }
        case 'rename': {
          const n = slugName(c.name, 30)
          if (!n) return 'Say a name with letters or numbers.'
          d.name = freeName(n, deps.taken)
          d.at = deps.now()
          return `It is called ${d.name.replace(/-/g, ' ')} now. Say "save it" to keep it.`
        }
        case 'trigger':
          return 'Styles have no trigger phrase. Once it is saved, say "turn on" and its name, then "mode".'
        case 'read':
          d.at = deps.now()
          return `${d.description} ${d.instructions.replace(/\n+/g, ' ')}`
        case 'discard':
          draft = null
          return 'Discarded.'
      }
    },
    draft: () => live()
  }
}
