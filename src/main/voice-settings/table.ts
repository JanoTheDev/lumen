// The settings a voice-only user can change by voice: one row per setting. Pure data, no
// Electron. A row names the setting the way people say it, where it lives in the config and how
// it changes; grammar.ts builds the sentences from it and run.ts applies it through patchConfig.
//
// Adding a setting is one row. `scope: 'ambiguous'` marks names an app in front could also mean
// ("dark mode", "high contrast", "text size", "captions", "automatic updates"): those rows are
// claimed only when the words also say Lumen ("… in Lumen", "Lumen's …", "your …"); see the
// header of grammar.ts for the whole rule.
import { ACCENT_IDS } from '@shared/config'

export type Risk = 'low' | 'medium' | 'high'
export type RowScope = 'lumen' | 'ambiguous'

/** A confirm card shown before a change that loosens a guard. */
export interface RowConfirm {
  risk: Risk
  summary: string
}

interface RowBase {
  id: string
  /** Name in answers: "Spoken replies on." */
  label: string
  /** Spoken names, lower case, no punctuation; the first is used in "say … to undo". */
  names: string[]
  /** Extra names that count only with Lumen in the words, even on a 'lumen' row. */
  scopedNames?: string[]
  scope: RowScope
  /** Config path: top-level key, then nested keys. */
  path: readonly string[]
  /** Fixed sentences (normalized, whole utterance). `free`: no Lumen words needed. */
  phrases?: { re: RegExp; to: unknown; free?: boolean }[]
  /** Fixed questions about the current value. */
  queries?: RegExp[]
  /** show / hide also switch it. */
  visual?: boolean
  /** Help sheet row. */
  help?: { say: string; does: string }
}

export interface BoolRow extends RowBase {
  kind: 'bool'
  /** Stored value for on (a function of the current value) and off; default true / false. */
  on?: unknown | ((cur: unknown) => unknown)
  off?: unknown
  isOn?: (v: unknown) => boolean
  confirmOn?: RowConfirm
  confirmOff?: RowConfirm
}

export interface EnumValue {
  value: string | boolean
  label: string
  /** Spoken words for the value. */
  words: string[]
}

export interface EnumRow extends RowBase {
  kind: 'enum'
  values: EnumValue[]
  /** Values "turn on X" / "turn off X" pick (when the setting has an on / off sense). */
  onValue?: string | boolean
  offValue?: string | boolean
  /** Confirm card before a value. */
  confirm?: Record<string, RowConfirm>
}

export interface NumberRow extends RowBase {
  kind: 'number'
  min: number
  max: number
  step: number
  reset: number
  /** Words after "make X …": bigger / faster / more sensitive. */
  more: string[]
  less: string[]
  /** Read back the value: "150 percent". */
  fmt: (n: number) => string
  /** Sentences that move it one step (whole utterance). */
  morePhrases?: RegExp[]
  lessPhrases?: RegExp[]
  resetPhrases?: RegExp[]
  /** Said back to undo a step / reset (must parse back: tested). */
  sayMore: string
  sayLess: string
  sayReset: string
}

export type SettingRow = BoolRow | EnumRow | NumberRow

const pct = (n: number): string => `${Math.round(n * 100)} percent`
const rate = (n: number): string => `${Number(n.toFixed(2))} times normal speed`

/** Voice languages and their names in each supported language (accents stripped). */
export const LANGUAGE_WORDS: Record<string, { label: string; words: string[] }> = {
  en: {
    label: 'English',
    words: ['english', 'ingles', 'englisch', 'anglais', 'inglese', 'engels']
  },
  es: {
    label: 'Spanish',
    words: [
      'spanish',
      'espanol',
      'castellano',
      'spanisch',
      'espagnol',
      'spagnolo',
      'espanhol',
      'spaans'
    ]
  },
  de: {
    label: 'German',
    words: ['german', 'aleman', 'deutsch', 'allemand', 'tedesco', 'alemao', 'duits']
  },
  fr: {
    label: 'French',
    words: ['french', 'frances', 'franzosisch', 'francais', 'francese', 'frans']
  },
  it: { label: 'Italian', words: ['italian', 'italiano', 'italienisch', 'italien', 'italiaans'] },
  pt: {
    label: 'Portuguese',
    words: ['portuguese', 'portugues', 'portugiesisch', 'portugais', 'portoghese', 'portugees']
  },
  nl: {
    label: 'Dutch',
    words: [
      'dutch',
      'holandes',
      'neerlandes',
      'niederlandisch',
      'hollandisch',
      'neerlandais',
      'olandese',
      'nederlands',
      'hollands'
    ]
  }
}

/** English spellings: a bare "in German" is a translation request, never a setting. */
export const ENGLISH_LANGUAGE_NAMES = new Set(Object.values(LANGUAGE_WORDS).map((l) => l.words[0]))

const THEMES: EnumValue[] = [
  { value: 'dark', label: 'dark', words: ['dark'] },
  { value: 'light', label: 'light', words: ['light'] },
  { value: 'high-contrast', label: 'high contrast', words: ['high contrast'] },
  { value: 'system', label: 'the Windows setting', words: ['system', 'automatic', 'default'] },
  { value: 'ocean', label: 'ocean', words: ['ocean'] },
  { value: 'forest', label: 'forest', words: ['forest'] },
  { value: 'sunset', label: 'sunset', words: ['sunset'] },
  { value: 'midnight', label: 'midnight', words: ['midnight'] }
]

const ACCENTS: EnumValue[] = ACCENT_IDS.map((id) => ({
  value: id,
  label: id,
  words: id === 'violet' ? ['violet', 'purple'] : id === 'yellow' ? ['yellow', 'gold'] : [id]
}))

const helper = (
  id: string,
  key: string,
  label: string,
  names: string[],
  help?: RowBase['help']
): BoolRow => ({ id, kind: 'bool', label, names, scope: 'lumen', path: ['helpers', key], help })

const dictation = (id: string, key: string, label: string, names: string[]): BoolRow => ({
  id,
  kind: 'bool',
  label,
  names,
  scope: 'lumen',
  path: ['dictation', key]
})

const ANSWERS = '(?:your |the |my )?(?:answers|replies)'
const ALOUD = '(?: out loud| aloud)?'

export const SETTINGS: readonly SettingRow[] = [
  // ---- voice ----
  {
    id: 'spoken-replies',
    kind: 'bool',
    label: 'Spoken replies',
    names: ['spoken replies', 'voice replies', 'spoken answers', 'voice answers', 'your voice'],
    scope: 'lumen',
    path: ['voice', 'tts'],
    on: (cur) => (cur === 'off' || cur === undefined ? 'windows' : cur),
    off: 'off',
    isOn: (v) => v !== 'off',
    phrases: [
      { re: /^talk to me$/, to: true },
      { re: /^talk back to me$/, to: true },
      { re: new RegExp(`^(?:read|speak|say) ${ANSWERS}${ALOUD}$`), to: true },
      { re: /^(?:answer|reply) out loud$/, to: true },
      { re: /^unmute (?:your voice|yourself)$/, to: true },
      {
        re: new RegExp(
          `^(?:dont|do not|stop) (?:read|reading|speak|speaking|say|saying) ${ANSWERS}${ALOUD}$`
        ),
        to: false
      },
      { re: /^mute (?:your voice|yourself)$/, to: false }
    ],
    queries: [
      /^(?:are|do) you (?:speaking|speak|reading|read) (?:your )?(?:answers|replies)(?: out loud| aloud)?$/
    ],
    help: {
      say: 'read answers aloud',
      does: 'Turn spoken replies on ("mute your voice" turns them off)'
    }
  },
  {
    id: 'speech-rate',
    kind: 'number',
    label: 'Speaking speed',
    names: [
      'speaking speed',
      'speech speed',
      'speech rate',
      'voice speed',
      'talking speed',
      'reading speed'
    ],
    scope: 'lumen',
    path: ['voice', 'ttsRate'],
    min: 0.25,
    max: 4,
    step: 0.25,
    reset: 1,
    more: ['faster', 'quicker'],
    less: ['slower'],
    fmt: rate,
    morePhrases: [
      /^(?:speak|talk|read) (?:a (?:little |bit |lot )?)?(?:faster|quicker|more quickly)$/,
      /^(?:speak|talk|read) (?:a )?(?:little|bit) (?:faster|quicker)$/
    ],
    lessPhrases: [
      /^(?:speak|talk|read) (?:a (?:little |bit |lot )?)?(?:slower|more slowly)$/,
      /^(?:speak|talk|read) (?:a )?(?:little|bit) (?:slower|more slowly)$/,
      /^(?:speak|talk|read) slowly$/
    ],
    resetPhrases: [/^(?:speak|talk|read) at (?:the )?(?:normal|regular|usual|default) speed$/],
    sayMore: 'speak faster',
    sayLess: 'speak slower',
    sayReset: 'speak at normal speed',
    help: { say: 'speak slower', does: 'Slow down (or speed up) spoken replies' }
  },
  {
    id: 'language',
    kind: 'enum',
    label: 'Language',
    names: ['language', 'voice language', 'reply language', 'spoken language'],
    scope: 'lumen',
    path: ['voice', 'language'],
    values: [
      ...Object.entries(LANGUAGE_WORDS).map(([value, l]) => ({
        value,
        label: l.label,
        words: l.words
      })),
      { value: 'auto', label: 'detect the language', words: ['automatic', 'auto', 'auto detect'] }
    ],
    queries: [
      /^what language (?:are you (?:speaking|using|in|set to)|do you speak|do you (?:reply|answer) in)$/
    ],
    help: { say: 'speak Spanish', does: 'Change the language Lumen listens and answers in' }
  },
  {
    id: 'conversation',
    kind: 'bool',
    label: 'Conversation mode',
    names: ['conversation mode', 'conversations', 'double tap conversations'],
    scope: 'lumen',
    path: ['voice', 'conversation'],
    help: {
      say: 'turn off conversation mode',
      does: 'Double-tap the hotkey to keep talking (on / off)'
    }
  },
  {
    id: 'talk-mode',
    kind: 'enum',
    label: 'Hotkey',
    names: ['talk mode', 'hotkey mode', 'shortcut mode', 'activation mode', 'push to talk mode'],
    scope: 'lumen',
    path: ['handsFreeMode'],
    values: [
      { value: true, label: 'tap to talk', words: ['tap', 'tapping', 'tap mode', 'tap to talk'] },
      {
        value: false,
        label: 'hold to talk',
        words: ['hold', 'holding', 'hold mode', 'hold to talk', 'push to talk']
      }
    ],
    phrases: [
      { re: /^(?:use |switch to |change to )?(?:the )?tap (?:mode|to talk)$/, to: true },
      { re: /^(?:use |switch to |change to )?(?:the )?hold (?:mode|to talk)$/, to: false },
      { re: /^let me tap (?:once |the (?:hotkey|shortcut) )?to talk$/, to: true },
      { re: /^let me hold (?:the (?:hotkey|shortcut) )?to talk$/, to: false }
    ],
    help: {
      say: 'use tap to talk',
      does: 'Tap the hotkey once instead of holding it ("use hold to talk")'
    }
  },
  {
    id: 'barge-in',
    kind: 'bool',
    label: 'Interrupting by voice',
    names: ['barge in', 'interrupting you', 'voice interruptions'],
    scope: 'lumen',
    path: ['voice', 'bargeIn'],
    phrases: [
      { re: /^let me interrupt you$/, to: true },
      { re: /^dont let me interrupt you$/, to: false }
    ]
  },
  {
    id: 'screen-reader-speech',
    kind: 'bool',
    label: 'Speaking alongside the screen reader',
    names: ['speaking with the screen reader', 'speaking over the screen reader'],
    scope: 'lumen',
    path: ['voice', 'ttsWithScreenReader'],
    phrases: [
      {
        re: /^(?:speak|talk) (?:even )?(?:with|over|alongside) (?:my |the )?screen reader$/,
        to: true
      },
      {
        re: /^(?:dont|stop) (?:speak|speaking|talk|talking) (?:with|over|alongside) (?:my |the )?screen reader$/,
        to: false
      }
    ]
  },
  {
    id: 'wake-word',
    kind: 'bool',
    label: 'Wake word',
    names: ['wake word', 'wake phrase', 'wake up word'],
    scope: 'lumen',
    path: ['wakeWord', 'enabled'],
    help: { say: 'turn on the wake word', does: 'Start Lumen by saying its wake word' }
  },
  {
    id: 'wake-sensitivity',
    kind: 'number',
    label: 'Wake word sensitivity',
    names: ['wake word sensitivity', 'wake sensitivity'],
    scope: 'lumen',
    path: ['wakeWord', 'sensitivity'],
    min: 0,
    max: 1,
    step: 0.1,
    reset: 0.5,
    more: ['more sensitive', 'higher'],
    less: ['less sensitive', 'lower'],
    fmt: pct,
    morePhrases: [/^make (?:the |your )?wake word more sensitive$/],
    lessPhrases: [/^make (?:the |your )?wake word less sensitive$/],
    sayMore: 'make the wake word more sensitive',
    sayLess: 'make the wake word less sensitive',
    sayReset: 'reset the wake word sensitivity'
  },

  // ---- seeing ----
  {
    id: 'text-size',
    kind: 'number',
    label: 'Text size',
    names: ['text size', 'text', 'font size', 'font', 'text scale', 'letters'],
    scope: 'ambiguous',
    path: ['a11y', 'uiScale'],
    min: 0.5,
    max: 3,
    step: 0.25,
    reset: 1,
    more: ['bigger', 'larger'],
    less: ['smaller'],
    fmt: pct,
    morePhrases: [
      /^(?:make )?(?:the |your )?(?:text|font|letters|writing|everything)(?: size)? (?:a (?:little |bit |lot )?)?(?:bigger|larger)$/,
      /^(?:bigger|larger) (?:text|font|letters)$/
    ],
    lessPhrases: [
      /^(?:make )?(?:the |your )?(?:text|font|letters|writing|everything)(?: size)? (?:a (?:little |bit |lot )?)?smaller$/,
      /^smaller (?:text|font|letters)$/
    ],
    resetPhrases: [
      /^(?:make )?(?:the |your )?(?:text|font)(?: size)? (?:normal|normal size|regular size|the normal size)$/
    ],
    sayMore: 'make your text bigger',
    sayLess: 'make your text smaller',
    sayReset: 'reset your text size',
    help: { say: 'make your text bigger', does: 'Bigger (or smaller) text in Lumen' }
  },
  {
    id: 'simple-mode',
    kind: 'bool',
    label: 'Simple mode',
    names: ['simple mode', 'simple view'],
    scope: 'lumen',
    path: ['a11y', 'simpleMode'],
    help: { say: 'turn on simple mode', does: 'Fewer choices and plain answers' }
  },
  {
    id: 'reduce-motion',
    kind: 'bool',
    label: 'Reduce motion',
    names: ['reduce motion', 'reduced motion', 'less motion'],
    scopedNames: ['motion reduction'],
    scope: 'lumen',
    path: ['a11y', 'reduceMotion'],
    on: 'on',
    off: 'off',
    isOn: (v) => v === 'on'
  },
  {
    id: 'high-contrast',
    kind: 'bool',
    label: 'High contrast',
    names: ['high contrast', 'higher contrast', 'extra contrast'],
    scope: 'ambiguous',
    path: ['a11y', 'contrast'],
    on: 'on',
    off: 'off',
    isOn: (v) => v === 'on',
    help: { say: 'turn on high contrast in Lumen', does: 'Stronger contrast in Lumen' }
  },
  {
    id: 'theme',
    kind: 'enum',
    label: 'Theme',
    names: ['theme', 'colour theme', 'color theme', 'colours', 'colors'],
    scope: 'ambiguous',
    path: ['theme'],
    values: THEMES,
    phrases: [
      {
        re: /^(?:turn on |switch on |switch to |use |go to |enable )?(?:the )?dark mode(?: on)?$/,
        to: 'dark'
      },
      { re: /^(?:turn off |switch off |disable )(?:the )?dark mode$|^dark mode off$/, to: 'light' },
      {
        re: /^(?:turn on |switch on |switch to |use |go to |enable )?(?:the )?light mode(?: on)?$/,
        to: 'light'
      },
      { re: /^(?:turn off |switch off |disable )(?:the )?light mode$|^light mode off$/, to: 'dark' }
    ],
    help: {
      say: 'use the Lumen dark theme',
      does: 'Change Lumen’s theme (dark, light, high contrast, ocean …)'
    }
  },
  {
    id: 'accent',
    kind: 'enum',
    label: 'Accent colour',
    names: ['accent', 'accent colour', 'accent color', 'highlight colour', 'highlight color'],
    scope: 'ambiguous',
    path: ['accent'],
    values: ACCENTS
  },

  // ---- hearing ----
  {
    id: 'captions',
    kind: 'bool',
    label: 'Captions',
    names: ['captions', 'subtitles', 'live captions'],
    scope: 'ambiguous',
    path: ['a11y', 'captions'],
    visual: true,
    phrases: [
      {
        re: /^(?:caption|subtitle) (?:what you say|your (?:voice|replies|answers))$/,
        to: true,
        free: true
      },
      {
        re: /^show (?:your )?(?:replies|answers|what you say) as (?:text|captions)$/,
        to: true,
        free: true
      },
      {
        re: /^(?:stop|dont) (?:captioning|subtitling) (?:what you say|your (?:voice|replies|answers))$/,
        to: false,
        free: true
      }
    ],
    help: { say: 'turn on Lumen captions', does: 'Show what Lumen says as captions' }
  },
  {
    id: 'announce',
    kind: 'bool',
    label: 'Spoken updates',
    names: ['spoken updates', 'spoken status updates', 'progress announcements'],
    scopedNames: ['announcements', 'status updates'],
    scope: 'lumen',
    path: ['a11y', 'announce'],
    on: 'auto',
    off: 'off',
    isOn: (v) => v !== 'off'
  },
  {
    id: 'focus-narration',
    kind: 'bool',
    label: 'Focus narration',
    names: ['focus narration', 'reading what i focus on'],
    scope: 'lumen',
    path: ['a11y', 'focusNarration'],
    phrases: [
      { re: /^read (?:out )?what(?:ever)? i focus(?: on)?$/, to: true },
      { re: /^(?:stop|dont) (?:read|reading) (?:out )?what(?:ever)? i focus(?: on)?$/, to: false }
    ],
    help: { say: 'read what I focus on', does: 'Say the name of whatever gets keyboard focus' }
  },

  // ---- thinking and focus ----
  {
    id: 'explain-before',
    kind: 'bool',
    label: 'Explaining before acting',
    names: ['explain before doing', 'explaining before acting', 'explanations before actions'],
    scope: 'lumen',
    path: ['explainBeforeDo'],
    phrases: [
      {
        re: /^explain (?:what you do |things )?before (?:you )?(?:do|doing|act|acting)(?: anything| things| it)?$/,
        to: true
      },
      { re: /^explain first$/, to: true },
      {
        re: /^(?:dont|stop|no need to) explain(?:ing)? (?:what you do |things )?before (?:you )?(?:do|doing|act|acting)(?: anything| things| it)?$/,
        to: false
      },
      { re: /^(?:dont|stop) explain(?:ing)? first$/, to: false }
    ]
  },
  {
    id: 'confidence',
    kind: 'bool',
    label: 'Showing how sure I am',
    names: ['confidence', 'confidence scores', 'confidence levels'],
    scope: 'lumen',
    path: ['showConfidence'],
    visual: true,
    phrases: [
      { re: /^show (?:me )?how sure you are$/, to: true },
      { re: /^(?:hide|dont show|stop showing) how sure you are$/, to: false }
    ]
  },
  {
    id: 'agent-confirm',
    kind: 'enum',
    label: 'Asking before actions',
    names: ['confirmations', 'action confirmations', 'asking before actions'],
    scope: 'lumen',
    path: ['agent', 'confirm'],
    values: [
      { value: 'always', label: 'always ask', words: ['always', 'every time', 'everything'] },
      {
        value: 'risky',
        label: 'ask for risky actions',
        words: ['risky', 'risky only', 'only risky']
      },
      { value: 'never', label: 'never ask', words: ['never', 'off'] }
    ],
    onValue: 'always',
    offValue: 'never',
    confirm: {
      never: {
        risk: 'high',
        summary:
          'Stop asking before actions? I would click, type and send without checking with you first (blocked actions stay blocked).'
      }
    },
    phrases: [
      {
        re: /^always ask (?:me )?(?:first|before (?:you )?(?:do|doing|act|acting)(?: anything| things)?)$/,
        to: 'always'
      },
      { re: /^only ask (?:me )?(?:before|about|for) risky (?:things|actions|stuff)$/, to: 'risky' },
      {
        re: /^(?:never ask|stop asking|dont ask) (?:me )?(?:first|before (?:you )?(?:do|doing|act|acting)(?: anything| things)?|for (?:confirmation|permission))$/,
        to: 'never'
      }
    ]
  },

  // ---- moving ----
  {
    id: 'dwell-click',
    kind: 'bool',
    label: 'Dwell clicking',
    names: ['dwell clicking', 'dwell click', 'dwell clicks', 'dwell control'],
    scope: 'lumen',
    path: ['dwellClick', 'enabled'],
    help: {
      say: 'turn on dwell clicking',
      does: 'Click by resting the pointer (“pause dwell” pauses it)'
    }
  },
  {
    id: 'switch-access',
    kind: 'bool',
    label: 'Switch access',
    names: ['switch access', 'switch control', 'switch input'],
    scope: 'lumen',
    path: ['a11y', 'switch', 'enabled'],
    help: { say: 'turn on switch access', does: 'Use one or two switches to scan and pick' }
  },
  {
    id: 'face-gestures',
    kind: 'bool',
    label: 'Face gestures',
    names: ['face gestures', 'facial gestures', 'face control', 'face input'],
    scope: 'lumen',
    path: ['a11y', 'face', 'enabled'],
    help: { say: 'turn on face gestures', does: 'Click and scroll with face gestures (camera)' }
  },

  // ---- smart helpers ----
  helper(
    'undo',
    'undo',
    'Undo for my actions',
    ['undo for your actions', 'undo history', 'undo'],
    undefined
  ),
  helper('what-changed', 'whatChanged', 'What changed', [
    'what changed',
    'what changed checks',
    'change tracking'
  ]),
  helper('error-rescue', 'errorRescue', 'Error rescue', [
    'error rescue',
    'error help',
    'help with errors'
  ]),
  helper('fatigue', 'fatigue', 'Comfort checks', [
    'comfort checks',
    'fatigue checks',
    'break suggestions'
  ]),
  helper('journal', 'journal', 'Learning journal', ['learning journal', 'journal']),
  helper(
    'pointing',
    'deictic',
    'Point and say',
    ['pointing', 'point and say', 'pointing commands'],
    {
      say: 'turn on pointing',
      does: 'Say "click this" while pointing'
    }
  ),
  helper('labels', 'labels', 'Community labels', [
    'community labels',
    'button labels',
    'control labels'
  ]),
  helper('focus-lessons', 'focusWithLessons', 'Focus mode in lessons', [
    'focus mode in lessons',
    'focus mode during lessons',
    'lesson focus'
  ]),
  {
    id: 'buddy',
    kind: 'bool',
    label: 'The buddy',
    names: ['buddy', 'on screen buddy', 'screen buddy', 'cursor buddy', 'pointer buddy'],
    scope: 'lumen',
    path: ['buddy', 'enabled'],
    visual: true,
    help: { say: 'hide the buddy', does: 'Show or hide the on-screen buddy' }
  },
  {
    id: 'buddy-follow',
    kind: 'bool',
    label: 'Buddy following the pointer',
    names: ['buddy following', 'buddy following the pointer'],
    scope: 'lumen',
    path: ['buddy', 'followCursor'],
    phrases: [
      {
        re: /^(?:make )?(?:the |your )?buddy follow (?:me|(?:my |the )?(?:pointer|mouse|cursor))$/,
        to: true
      },
      {
        re: /^(?:make )?(?:the |your )?buddy (?:stop following|stay put|stay still)(?: me| (?:my |the )?(?:pointer|mouse|cursor))?$/,
        to: false
      },
      {
        re: /^stop (?:the |your )?buddy following (?:me|(?:my |the )?(?:pointer|mouse|cursor))$/,
        to: false
      }
    ]
  },

  // ---- memory ----
  {
    id: 'memory',
    kind: 'bool',
    label: 'Memory',
    names: ['memory', 'long term memory'],
    scope: 'lumen',
    path: ['memory', 'enabled'],
    help: {
      say: 'turn on memory',
      does: 'Let Lumen remember facts about you ("private mode" pauses it)'
    }
  },
  {
    id: 'auto-learn',
    kind: 'enum',
    label: 'Learning about you',
    names: ['auto learn', 'auto learning', 'learning about me'],
    scope: 'lumen',
    path: ['memory', 'autoLearn'],
    values: [
      { value: 'auto', label: 'on', words: ['auto', 'automatic', 'on'] },
      { value: 'ask', label: 'ask first', words: ['ask', 'ask first', 'ask me'] },
      { value: 'off', label: 'off', words: ['off', 'never'] }
    ],
    onValue: 'auto',
    offValue: 'off',
    phrases: [
      {
        re: /^ask (?:me )?(?:first )?before (?:you )?(?:learn|learning|remember|remembering)(?: things| anything| about me)?$/,
        to: 'ask'
      }
    ]
  },

  // ---- dictation ----
  dictation('dictation-sounds', 'sounds', 'Dictation sounds', [
    'dictation sounds',
    'dictation beeps'
  ]),
  dictation('caret-pill', 'caretPill', 'Dictation pill by the cursor', [
    'caret pill',
    'dictation pill'
  ]),
  {
    ...dictation('duck-media', 'duckMedia', 'Lowering the volume while you dictate', [
      'media ducking',
      'volume ducking',
      'ducking'
    ]),
    phrases: [
      { re: /^lower (?:the )?(?:volume|music|media|sound) (?:while|when) i dictate$/, to: true },
      {
        re: /^(?:dont|stop) lower(?:ing)? (?:the )?(?:volume|music|media|sound) (?:while|when) i dictate$/,
        to: false
      }
    ]
  },
  dictation('coding-mode', 'codingMode', 'Coding mode for dictation', [
    'coding mode',
    'dictation coding mode',
    'code dictation'
  ]),
  dictation('dictation-history', 'history', 'Dictation history', ['dictation history']),

  // ---- system ----
  {
    id: 'start-at-login',
    kind: 'bool',
    label: 'Starting when you sign in',
    names: ['start at login', 'starting at login', 'start at sign in', 'start with windows'],
    scope: 'lumen',
    path: ['system', 'startAtLogin'],
    phrases: [
      {
        re: /^(?:start|open|launch) (?:at|on) (?:login|log in|sign in|startup|start up)$/,
        to: true
      },
      {
        re: /^(?:start|open|launch) (?:with windows|automatically|when i (?:log|sign) in)$/,
        to: true
      },
      {
        re: /^(?:dont|do not|stop) (?:start|starting|open|opening|launch|launching) (?:at|on) (?:login|log in|sign in|startup|start up)$/,
        to: false
      },
      {
        re: /^(?:dont|do not|stop) (?:start|starting|open|opening|launch|launching) (?:with windows|automatically|when i (?:log|sign) in)$/,
        to: false
      }
    ],
    help: { say: 'start Lumen with Windows', does: 'Start Lumen when you sign in' }
  },
  {
    id: 'auto-update',
    kind: 'bool',
    label: 'Automatic updates',
    names: ['automatic updates', 'auto updates', 'auto update', 'updates'],
    scope: 'ambiguous',
    path: ['system', 'autoUpdate']
  },
  {
    id: 'local-only',
    kind: 'bool',
    label: 'Local only',
    names: ['local only', 'local only mode', 'local models only', 'local mode'],
    scope: 'lumen',
    path: ['models', 'localOnly'],
    isOn: (v) => v === true,
    confirmOff: {
      risk: 'medium',
      summary:
        'Use cloud models again? Your questions and screenshots can then be sent to your AI provider.'
    },
    phrases: [
      { re: /^(?:only use|use only|use) local models(?: only)?$/, to: true },
      { re: /^(?:dont|do not|stop) (?:use|using) (?:the )?cloud(?: models)?$/, to: true },
      { re: /^use (?:the )?cloud(?: models)?(?: again)?$/, to: false }
    ],
    help: { say: 'turn on local only', does: 'Use only models on this PC, never the cloud' }
  }
]

export function rowById(id: string): SettingRow | undefined {
  return SETTINGS.find((r) => r.id === id)
}
