// Help topics for "what can I say" (06 T21): rows other modules contribute to the help sheet,
// one group each, and the spoken answer to "what can I say about <topic>". Pure.
//
//   registerHelpRows('Buddies', () => [{ say: 'pause all buddies', does: 'Pause every buddy' }],
//     { words: ['buddy'] })
//
// Rows are read each time the sheet opens, so a group can show only what applies. Registering
// a group again replaces it; the returned function removes it.

export interface HelpRow {
  /** What to say, as the user would say it. */
  say: string
  /** What it does, short. */
  does: string
}

export interface HelpGroupOptions {
  /** More words that name the group by voice ("buddy" for Buddies). */
  words?: readonly string[]
}

interface Group {
  title: string
  rows: () => readonly HelpRow[]
  words: string[]
}

const groups = new Map<string, Group>()

/** One word without its plural ending: "buddies" → "buddy", "notes" → "note", "news" stays. */
function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is|ws)$/.test(w)) return w.slice(0, -1)
  return w
}

/** "Buddies", "the buddy", "my buddies" → "buddy"; lower case, plural and articles dropped. */
export function topicKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(?:the|my|your|a|an)\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(' ')
}

/** Adds (or replaces) a group of help rows; returns a function that removes it again. */
export function registerHelpRows(
  title: string,
  rows: () => readonly HelpRow[],
  opts: HelpGroupOptions = {}
): () => void {
  const id = topicKey(title)
  const group: Group = { title, rows, words: [id, ...(opts.words ?? []).map(topicKey)] }
  groups.set(id, group)
  return () => {
    if (groups.get(id) === group) groups.delete(id)
  }
}

function safeRows(g: Group): HelpRow[] {
  try {
    return g.rows().filter((r) => r.say.trim() && r.does.trim())
  } catch {
    return []
  }
}

/** Every group with rows, in registration order. */
export function helpGroups(): { title: string; rows: HelpRow[] }[] {
  return [...groups.values()]
    .map((g) => ({ title: g.title, rows: safeRows(g) }))
    .filter((g) => g.rows.length > 0)
}

/** The group a spoken topic names ("buddies", "the head pointer"), else null. */
export function findHelpGroup(topic: string): { title: string; rows: HelpRow[] } | null {
  const t = topicKey(topic)
  if (!t) return null
  const padded = ` ${t} `
  let best: { g: Group; len: number } | null = null
  for (const g of groups.values()) {
    for (const w of g.words) {
      if (!w) continue
      const hit = t === w || padded.includes(` ${w} `)
      if (hit && (!best || w.length > best.len)) best = { g, len: w.length }
    }
  }
  if (!best) return null
  const rows = safeRows(best.g)
  return rows.length ? { title: best.g.title, rows } : null
}

/** The spoken answer for one group: a few phrases, short enough to listen to. */
export function helpTopicText(group: { title: string; rows: readonly HelpRow[] }, max = 5): string {
  const lines = group.rows.slice(0, max).map((r) => `“${r.say}”: ${lowerFirst(r.does)}.`)
  const more = group.rows.length > max ? ' The help sheet has more.' : ''
  return `For ${group.title.toLowerCase()}, you can say: ${lines.join(' ')}${more}`
}

function lowerFirst(s: string): string {
  const t = s.trim().replace(/[.]+$/, '')
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t
}

// ---- Built-in groups: phrases the other voice grammars match (whole utterances) ----

const rows = (list: [string, string][]): (() => HelpRow[]) => {
  const out = list.map(([say, does]) => ({ say, does }))
  return () => out
}

const BUILT_IN: [string, [string, string][], string[]][] = [
  [
    'Answers',
    [
      ['repeat that', 'Say the last answer again'],
      ['copy the answer', 'Copy the answer text'],
      ['pin', 'Keep the answer on screen'],
      ['longer', 'Give me more time before it closes'],
      ['dismiss', 'Close the answer']
    ],
    ['answer', 'reply']
  ],
  [
    'Buddies',
    [
      ['make a buddy that checks my inbox every morning', 'Make a buddy'],
      ['Inbox Buddy, what’s new?', 'Ask a buddy by its name'],
      ['what are my buddies doing', 'Hear what each buddy is up to'],
      ['stop Inbox Buddy', 'Stop what a buddy is running'],
      ['pause all buddies', 'Pause every buddy (“resume buddies” to go on)']
    ],
    ['buddy']
  ],
  [
    'Automations',
    [
      ['every weekday at 9 summarize my inbox', 'Run something on a schedule'],
      ['in 20 minutes remind me to stretch', 'Set a reminder'],
      ['when I open Excel, remind me to save a copy', 'Do something when an app opens'],
      ['when a PDF lands in Downloads, rename it by its title', 'Act on new files in a folder'],
      ['in the background, check the news about my team', 'Run a task while you work']
    ],
    ['automation', 'routine', 'schedule', 'reminder', 'background', 'background task', 'task']
  ],
  [
    'Smart helpers',
    [
      ['focus mode on', 'Dim everything but what matters'],
      ['show everything', 'Turn focus mode off'],
      ['undo what you just did', 'Undo Lumen’s last task'],
      ['what changed', 'Hear what changed on screen'],
      ['explain this error', 'Explain the error on screen'],
      ['what did I learn today', 'Hear your learning journal']
    ],
    ['helper', 'smart helper', 'focus', 'focus mode', 'undo', 'journal', 'error']
  ],
  [
    'Head pointer',
    [
      ['head pointer on', 'Move the mouse with your head'],
      ['recentre', 'Centre the head pointer again'],
      ['pause the head pointer', 'Hold the pointer still (“resume the head pointer”)'],
      ['head pointer off', 'Stop the head pointer']
    ],
    ['face', 'face gesture', 'gesture', 'head', 'head mouse', 'pointer']
  ],
  [
    'Memory and privacy',
    [
      ['remember that I like short answers', 'Remember something about you'],
      ['what do you remember about me', 'Hear what Lumen knows'],
      ['forget about my trip', 'Forget a topic'],
      ['private mode on', 'Stop remembering for now (“private mode off”)'],
      ['where were we', 'Pick up where you left off']
    ],
    ['memory', 'remember', 'private mode', 'private', 'privacy', 'forget']
  ],
  [
    'Reply styles',
    [
      ['turn on brief mode', 'Change how answers are worded'],
      ['brief mode ultra', 'The same style, stronger'],
      ['what mode am I in', 'Hear the style in use'],
      ['normal mode', 'Answer in the normal way again'],
      ['make a style that talks like a pirate', 'Make your own style']
    ],
    ['style', 'reply style', 'mode', 'tone']
  ],
  [
    'Notes',
    [
      ['take a note call the dentist on Monday', 'Save a note'],
      ['save this to my notes', 'Save the page or answer to your notes']
    ],
    ['note', 'scratchpad']
  ],
  [
    'Files and documents',
    [
      ['make a Word doc of this', 'Write a Word document'],
      ['convert this csv to Excel', 'Turn a CSV into a spreadsheet'],
      ['summarize this file', 'Read the file you point at or dropped on the bar'],
      ['open it', 'Open the file Lumen just made'],
      ['show it in Explorer', 'Show where it was saved']
    ],
    ['file', 'document', 'doc', 'word', 'excel', 'pdf', 'spreadsheet']
  ],
  [
    'Answer cards',
    [
      ['open the second one', 'Open a result'],
      ['compare them', 'See the results side by side'],
      ['show me cheaper ones', 'Search again for cheaper'],
      ['tell me more about the first one', 'Hear more about a result'],
      ['save them to my notes', 'Keep the results']
    ],
    ['card', 'result', 'hotel', 'product', 'shopping', 'booking']
  ],
  [
    'Web and news',
    [
      ['summarize this page', 'Hear what the page says'],
      ['what does it say about prices', 'Ask about the page'],
      ['what’s the news', 'Top news now'],
      ['news about electric cars', 'News on one topic'],
      ['open the sources', 'Open where it came from']
    ],
    ['web', 'news', 'page', 'website', 'internet', 'article', 'browsing']
  ],
  [
    'Claude Code',
    [
      ['open Claude on my website project', 'Start or resume a Claude Code session'],
      ['what did Claude say', 'Hear Claude’s last reply'],
      ['approve', 'Allow what Claude asks (“deny” to refuse)'],
      ['autopilot careful', 'Let Lumen answer safe questions for Claude'],
      ['answer: use the second option', 'Answer Claude’s question']
    ],
    ['claude', 'claude code', 'coding', 'code']
  ]
]

for (const [title, list, words] of BUILT_IN) registerHelpRows(title, rows(list), { words })
