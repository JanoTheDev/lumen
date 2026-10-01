// Tutorial importer (11 T12): pasted transcript, web tutorial URL or subtitle file → lesson
// draft. YouTube is not fetched: its terms forbid automated access outside its player and
// API, and the captions API needs the video owner's OAuth. A YouTube link gets a plain
// explanation and the copy-the-transcript route instead. No Electron (deps injected).
import { appIdFor } from '../generate'
import type { Lesson } from '../lesson'
import { parseSubtitles, transcriptFromCues } from './subtitles'
import {
  MAX_SOURCE_CHARS,
  TUTORIAL_PROMPT,
  toTutorialLesson,
  tutorialTurn,
  type TutorialReply,
  type TutorialTurn
} from './tutorial'
import { fetchPage, htmlToArticle, ImportError, type FetchLike } from './web'

/** Less text than this is not a tutorial. */
export const MIN_SOURCE_CHARS = 200

export type TutorialSource =
  | { kind: 'text'; text: string }
  | { kind: 'url'; url: string }
  | { kind: 'subtitles'; text: string; name: string }

export interface ImportApp {
  id: string
  name: string
  regions?: Record<string, unknown>
  shortcuts?: string
}

export interface ImportDeps {
  fetch: FetchLike
  /** A pack by id. */
  app(id: string): ImportApp | null
  /** A pack whose name or id matches the words ("Blender 2.8" → blender). */
  appByName(name: string): ImportApp | null
  complete(system: string, user: string, signal?: AbortSignal): Promise<TutorialReply | null>
  /** Hands the lesson to the "record my steps" draft review. */
  offer(lesson: Lesson, note: string): { ok: boolean; error?: string }
  readingLevel(appId?: string): string
  log(msg: string): void
}

export type ImportResult =
  | { ok: true; title: string; steps: number; appName: string; drift: string }
  | { ok: false; error: string }

const YOUTUBE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i

export const YOUTUBE_MESSAGE =
  'I can’t read YouTube videos myself: YouTube’s terms don’t allow it. Open the video’s transcript (More, then Show transcript), copy it, and paste it here or say “make a lesson from the clipboard”.'

function youtube(url: string): boolean {
  try {
    return YOUTUBE.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/** One https address on its own. */
const urlOnly = (s: string): string | null => {
  const t = s.trim()
  return /^https?:\/\/\S+$/i.test(t) ? t : null
}

async function sourceText(
  src: TutorialSource,
  deps: ImportDeps,
  signal?: AbortSignal
): Promise<Omit<TutorialTurn, 'appName' | 'regions' | 'shortcuts' | 'readingLevel'>> {
  if (src.kind === 'text') {
    const url = urlOnly(src.text)
    if (url) return sourceText({ kind: 'url', url }, deps, signal)
    if (src.text.includes('-->')) {
      const text = transcriptFromCues(parseSubtitles(src.text))
      if (text) return { source: 'subtitles', text }
    }
    return { source: 'transcript', text: src.text.trim() }
  }
  if (src.kind === 'subtitles') {
    const cues = parseSubtitles(src.text)
    const text = cues.length ? transcriptFromCues(cues) : src.text.trim()
    return { source: 'subtitles', text, title: src.name.replace(/\.(srt|vtt|txt)$/i, '') }
  }
  if (youtube(src.url)) throw new ImportError(YOUTUBE_MESSAGE)
  const page = await fetchPage(src.url, deps.fetch, signal)
  const article = htmlToArticle(page.html)
  return { source: 'web', text: article.text, title: article.title, url: page.url }
}

export async function importTutorial(
  src: TutorialSource,
  opts: { appId?: string },
  deps: ImportDeps,
  signal?: AbortSignal
): Promise<ImportResult> {
  let turn: Awaited<ReturnType<typeof sourceText>>
  try {
    turn = await sourceText(src, deps, signal)
  } catch (e) {
    const msg =
      e instanceof ImportError ? e.message : `the page could not be read (${(e as Error).message})`
    deps.log(`tutorial import: ${msg}`)
    return { ok: false, error: msg }
  }
  if (turn.text.length < MIN_SOURCE_CHARS)
    return { ok: false, error: 'there is too little text to make a lesson from' }
  const picked = opts.appId ? deps.app(opts.appId) : null
  const user = tutorialTurn({
    ...turn,
    text: turn.text.slice(0, MAX_SOURCE_CHARS),
    appName: picked?.name,
    regions: picked?.regions ? Object.keys(picked.regions) : undefined,
    shortcuts: picked?.shortcuts,
    readingLevel: deps.readingLevel(picked?.id)
  })
  deps.log(
    `tutorial import: ${turn.source}, ${turn.text.length} chars${picked ? `, app ${picked.id}` : ''}`
  )
  const reply = await deps.complete(TUTORIAL_PROMPT, user, signal).catch((e: Error) => {
    deps.log(`tutorial import: model call failed (${e.message})`)
    return null
  })
  if (!reply) return { ok: false, error: 'the lesson could not be written this time' }
  const app =
    picked ??
    deps.appByName(reply.app) ??
    ({
      id: appIdFor(null, reply.app || 'desktop'),
      name: reply.app.trim() || 'Windows'
    } as ImportApp)
  const made = toTutorialLesson(reply, {
    appId: app.id,
    appName: app.name,
    regions: app.regions,
    sourceTitle: turn.title,
    url: turn.url
  })
  if (!made) return { ok: false, error: 'no usable steps were found in that tutorial' }
  const offered = deps.offer(made.lesson, made.drift)
  if (!offered.ok) return { ok: false, error: offered.error ?? 'the draft could not be shown' }
  return {
    ok: true,
    title: made.lesson.title,
    steps: made.lesson.steps.length,
    appName: app.name,
    drift: made.drift
  }
}

/** Voice: "make a lesson from the clipboard", "turn this tutorial into a lesson". */
export function matchImportCommand(utterance: string): boolean {
  const t = utterance
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return /^(?:make|create|build) (?:a )?lesson (?:from|out of) (?:the |my )?(?:clipboard|copied text|this tutorial|the tutorial i copied)$|^(?:turn|make) (?:this|the|my) (?:copied )?tutorial into a lesson$|^import (?:this|the) tutorial$/.test(
    t
  )
}
