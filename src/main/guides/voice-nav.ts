export type GuideNavCommand = 'next' | 'prev' | 'repeat' | 'done'

const FILLER = new Set(['okay', 'ok', 'please', 'lumen', 'hey', 'um', 'uh', 'alright', 'now'])

// Lowercase, drop punctuation and filler words, collapse whitespace.
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(' ')
}

const NAV_RULES: Array<[GuideNavCommand, RegExp]> = [
  ['next', /^(next( step)?|continue|go on)$/],
  ['prev', /^(back|previous( step)?|go back)$/],
  [
    'repeat',
    /^(repeat( that| it)?|say (that |it )?again|(say it|tell me) one more time|one more time|come again|what was that)$/
  ],
  ['done', /^(done|finish(ed)?|close (the )?guide|exit guide)$/]
]

// Only whole-utterance commands count, so real queries ("go back to gmail") pass through.
export function parseGuideNav(utterance: string): GuideNavCommand | null {
  const text = normalizeUtterance(utterance)
  if (!text) return null
  for (const [cmd, re] of NAV_RULES) {
    if (re.test(text)) return cmd
  }
  return null
}

// Save / replay / play need the word "guide" and must be the whole utterance.
export const REPLAY_RE =
  /^(replay (the )?(last )?guide|guide replay|(show|open|do|run|play) (me )?(the )?(last )?guide again|(show|open|play|run) (me )?the last guide|restart (the )?guide|last guide)$/

export function isReplayRequest(text: string): boolean {
  return REPLAY_RE.test(normalizeUtterance(text))
}

export const SAVE_GUIDE_RE =
  /^(save|remember)\s+(this\s+|the\s+)?guide(\s+as\s+(?<name>.{1,40}?))?[.!?]*$/i

function cleanName(name: string | undefined): string | undefined {
  const n = name
    ?.trim()
    .replace(/[.!?,;:]+$/, '')
    .trim()
  return n ? n : undefined
}

export function matchSaveGuide(text: string): { name?: string } | null {
  const m = SAVE_GUIDE_RE.exec(text.trim())
  if (!m) return null
  const name = cleanName(m.groups?.name)
  return name ? { name } : {}
}

export const PLAY_GUIDE_RE =
  /^(play|run|open)\s+(the\s+)?(saved\s+)?guide\s+(?:(?:named|called)\s+)?(?<name>.{2,40})$/i

export function matchPlayGuide(text: string): string | null {
  const m = PLAY_GUIDE_RE.exec(text.trim())
  const name = cleanName(m?.groups?.name)
  if (!name || /^again$/i.test(name)) return null
  return name
}
