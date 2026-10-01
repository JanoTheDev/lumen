// Whole-utterance voice commands for the helpers (11 Phase C), pure: focus mode, undo, "what
// changed?", reading level, the journal, error rescue and shortcut tips. Matched on the
// normalized utterance; anything longer or looser goes on to the model.
import type { ReadingLevel } from '@shared/config'

export type HelperCommand =
  | { kind: 'focus-on'; level?: 'soft' | 'strong'; region?: string }
  | { kind: 'focus-off' }
  /** "undo that": Lumen's last action, only right after it acted. */
  | { kind: 'undo'; n: number; that?: boolean }
  /** "undo everything you just did": the newest task's actions. */
  | { kind: 'undo-task' }
  | { kind: 'what-changed' }
  | { kind: 'reading-level'; level: ReadingLevel | 'simpler' | 'deeper'; here: boolean }
  | { kind: 'journal'; range: 'today' | 'week' }
  | { kind: 'explain-error' }
  /** "yes" / "yes please" / "explain it": only claimed while an error offer is open. */
  | { kind: 'accept-offer' }
  | { kind: 'shortcut-tips'; on: boolean }

const NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  couple: 2,
  few: 3
}

const MAX_WORDS = 12

/** Lower case, no punctuation, no leading "ok" / "please" / "hey lumen", no trailing "please". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:ok|okay|hey lumen|lumen|please|now|so)\s+)+/, '')
    .replace(/\s+(?:please|now|thanks|thank you)$/, '')
    .trim()
}

const num = (w: string): number | null => (/^\d+$/.test(w) ? Number(w) : (NUMBERS[w] ?? null))

const HERE = /\s+(?:here|in this app|for this app|in this program)$/

type Rule = [RegExp, (m: RegExpExecArray) => HelperCommand | null]

const RULES: Rule[] = [
  // ---- focus mode ----
  [/^(?:turn on |start |switch on |enable )?focus mode(?: on)?$/, () => ({ kind: 'focus-on' })],
  [
    /^(?:turn on |start )?(strong|soft|light|heavy) focus(?: mode)?(?: on)?$/,
    (m) => ({
      kind: 'focus-on',
      level: m[1] === 'strong' || m[1] === 'heavy' ? 'strong' : 'soft'
    })
  ],
  [
    /^(?:declutter|unclutter|simplify) (?:this|the screen|this app|this window|my screen)$/,
    () => ({ kind: 'focus-on' })
  ],
  [/^hide (?:the|all the|all this) clutter$/, () => ({ kind: 'focus-on' })],
  [
    /^(?:focus mode on|only show|just show) (?:me )?(?:the )?([a-z0-9 ]{3,40})$/,
    (m) => (/^(everything|all|it all)$/.test(m[1]) ? null : { kind: 'focus-on', region: m[1] })
  ],
  [
    /^(?:turn off |stop |end |exit |switch off |disable )focus mode$|^focus mode off$/,
    () => ({ kind: 'focus-off' })
  ],
  [
    /^(?:show (?:me )?everything|show it all|unhide everything|stop dimming|no more dimming)$/,
    () => ({ kind: 'focus-off' })
  ],

  // ---- undo ----
  [/^undo (?:that|this|it)$/, () => ({ kind: 'undo', n: 1, that: true })],
  [/^undo (?:your|the) last (?:action|step|change|thing)$/, () => ({ kind: 'undo', n: 1 })],
  [/^undo (?:what|the thing) you (?:just )?did$/, () => ({ kind: 'undo-task' })],
  [/^undo (?:everything|all) (?:that )?you (?:just )?did$/, () => ({ kind: 'undo-task' })],
  [
    /^(?:take that back|reverse that|put it back(?: how it was)?)$/,
    () => ({ kind: 'undo', n: 1, that: true })
  ],
  [
    /^undo (?:the )?last (\w+) (?:things|steps|actions|changes)$/,
    (m) => {
      const n = num(m[1])
      return n && n >= 1 && n <= 20 ? { kind: 'undo', n } : null
    }
  ],
  [
    /^undo (?:the )?last (?:couple|few) (?:of )?(?:things|steps|actions|changes)$/,
    (m) => ({
      kind: 'undo',
      n: m[0].includes('couple') ? 2 : 3
    })
  ],

  // ---- what changed ----
  [
    /^(?:what(?:'s| has| just)? changed|what's different|what is different|what happened)(?: on (?:the|my) screen)?$/,
    () => ({ kind: 'what-changed' })
  ],
  [
    /^(?:did (?:it|that) work|did that do anything|where did (?:the |that )?(?:new )?window go)$/,
    () => ({ kind: 'what-changed' })
  ],

  // ---- journal ----
  [
    /^what (?:did|have) i (?:learn|learned|learnt)(?: (today|this week|lately|recently))?$/,
    (m) => ({
      kind: 'journal',
      range: m[1] === 'today' ? 'today' : 'week'
    })
  ],
  [/^(?:what did i do|what have i done) today$/, () => ({ kind: 'journal', range: 'today' })],

  // ---- error rescue ----
  [
    /^(?:explain|help (?:me )?with|what does) (?:this|the|that) error(?: mean)?$/,
    () => ({ kind: 'explain-error' })
  ],
  [
    /^(?:what does (?:this|that) (?:message|error) mean|what is this error|what's this error)$/,
    () => ({ kind: 'explain-error' })
  ],
  [/^(?:yes|yes please|sure|explain it|yes explain(?: it)?)$/, () => ({ kind: 'accept-offer' })],

  // ---- shortcut tips ----
  [
    /^(?:stop|no more|turn off|disable) (?:the )?shortcut (?:tips|coach|hints)$/,
    () => ({ kind: 'shortcut-tips', on: false })
  ],
  [
    /^(?:turn on|start|enable) (?:the )?shortcut (?:tips|coach|hints)$|^shortcut (?:tips|coach) on$/,
    () => ({ kind: 'shortcut-tips', on: true })
  ]
]

const LEVEL_RULES: [RegExp, ReadingLevel | 'simpler' | 'deeper'][] = [
  [
    /^(?:explain (?:it |that |things )?simpler|simpler(?: words| explanations)?|use simpler words|keep it simple|plain (?:words|english|language)|explain like i'm (?:a beginner|five|new))$/,
    'simpler'
  ],
  [
    /^(?:more technical|be more technical|explain like an expert|expert (?:mode|explanations|level)|less basic)$/,
    'expert'
  ],
  [/^(?:normal|standard) (?:explanations|reading level|level|answers)$/, 'standard'],
  [/^reading level (plain|simple|standard|normal|expert)$/, 'standard']
]

function readingLevel(text: string): HelperCommand | null {
  const here = HERE.test(text)
  const core = text.replace(HERE, '')
  for (const [re, level] of LEVEL_RULES) {
    const m = re.exec(core)
    if (!m) continue
    if (m[1]) {
      const word = m[1]
      const lv: ReadingLevel =
        word === 'plain' || word === 'simple' ? 'plain' : word === 'expert' ? 'expert' : 'standard'
      return { kind: 'reading-level', level: lv, here }
    }
    return { kind: 'reading-level', level, here }
  }
  return null
}

export function parseHelperCommand(utterance: string): HelperCommand | null {
  const text = normalize(utterance)
  if (!text || text.split(' ').length > MAX_WORDS) return null
  for (const [re, make] of RULES) {
    const m = re.exec(text)
    if (m) {
      const cmd = make(m)
      if (cmd) return cmd
    }
  }
  return readingLevel(text)
}
