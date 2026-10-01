// Voice intents for the Claude Code copilot (claude-code.md "Voice surface"). Pure: the
// interceptor decides with the live state whether e.g. a bare "approve" is meant for Claude.
import type { AutopilotLevel } from '@shared/claude-code'

export type ClaudeIntent =
  | { kind: 'open'; project: string; prompt?: string }
  | { kind: 'tell'; text: string }
  | { kind: 'status' }
  | { kind: 'read-last' }
  | { kind: 'permission'; answer: 'once' | 'always' | 'deny' }
  | { kind: 'answer'; text: string }
  | { kind: 'stop' }
  | { kind: 'autopilot'; level: AutopilotLevel }
  | { kind: 'undo-answer' }

const CLAUDE = String.raw`claude(?:\s+code)?`

function clean(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
}

const RULES: [RegExp, (m: RegExpExecArray) => ClaudeIntent | null][] = [
  [
    new RegExp(
      String.raw`^(?:what(?:'s|’s| is| s)|how(?:'s|’s| is| s))\s+${CLAUDE}\s+(?:doing|up to)$|^${CLAUDE}\s+status$|^status of ${CLAUDE}$`,
      'i'
    ),
    () => ({ kind: 'status' })
  ],
  [
    new RegExp(
      String.raw`^(?:read (?:me )?(?:the |claude(?:'s|’s) )?last (?:answer|reply|message)(?: from ${CLAUDE})?|what did ${CLAUDE} (?:say|answer|reply))$`,
      'i'
    ),
    () => ({ kind: 'read-last' })
  ],
  [
    new RegExp(String.raw`^(?:stop|interrupt|cancel|halt) ${CLAUDE}$`, 'i'),
    () => ({ kind: 'stop' })
  ],
  [
    /^(?:turn |set )?autopilot (?:to )?(on|off|careful|full)$|^(?:turn )?(on|off) autopilot$|^(full|careful) autopilot$|^(pause|stop|resume) autopilot$/i,
    (m) => {
      const w = (m[1] ?? m[2] ?? m[3] ?? m[4]).toLowerCase()
      const level: AutopilotLevel =
        w === 'on' || w === 'full' ? 'full' : w === 'careful' || w === 'resume' ? 'careful' : 'off'
      return { kind: 'autopilot', level }
    }
  ],
  [/^undo (?:that|the|your|this) answer$/i, () => ({ kind: 'undo-answer' })],
  [
    /^(?:always allow(?: this| that| it)?|allow (?:this |that |it )?always|yes,? always)$/i,
    () => ({ kind: 'permission', answer: 'always' })
  ],
  [
    /^(?:approve(?: it| that| this)?|allow(?: it| that| this)?|yes,? allow(?: it)?)$/i,
    () => ({ kind: 'permission', answer: 'once' })
  ],
  [
    /^(?:deny(?: it| that| this)?|reject(?: it| that)?|don'?t allow(?: it| that)?|do not allow(?: it| that)?)$/i,
    () => ({ kind: 'permission', answer: 'deny' })
  ],
  [/^answer[:,]?\s+(.+)$/i, (m) => ({ kind: 'answer', text: m[1] })],
  [
    new RegExp(
      String.raw`^(?:open|start|launch|resume|continue)\s+${CLAUDE}\s+(?:on|in|for|with)\s+(.+?)(?:\s+and\s+(.+))?$`,
      'i'
    ),
    (m) => open(m[1], m[2])
  ],
  [
    new RegExp(
      String.raw`^(?:open|start|resume|continue|work on)\s+(.+?)\s+(?:in|with)\s+${CLAUDE}(?:\s+and\s+(.+))?$`,
      'i'
    ),
    (m) => open(m[1], m[2])
  ],
  [
    new RegExp(String.raw`^(?:tell|ask)\s+${CLAUDE}\s+(?:to\s+)?(.+)$`, 'i'),
    (m) => ({ kind: 'tell', text: m[1] })
  ],
  [
    new RegExp(String.raw`^(?:hey\s+)?${CLAUDE}\s*[,:]\s*(.+)$`, 'i'),
    (m) => ({ kind: 'tell', text: m[1] })
  ]
]

function open(project: string, prompt?: string): ClaudeIntent | null {
  const p = project.replace(/^(?:the|my)\s+/i, '').trim()
  if (!p) return null
  return { kind: 'open', project: p, ...(prompt?.trim() ? { prompt: prompt.trim() } : {}) }
}

export function matchClaudeCodeIntent(text: string): ClaudeIntent | null {
  const t = clean(text)
  if (!t || t.length > 2000) return null
  for (const [re, make] of RULES) {
    const m = re.exec(t)
    if (m) return make(m)
  }
  return null
}

/** Intents that only mean something to Claude while it waits (bare "approve", "answer: …"). */
export function needsPending(i: ClaudeIntent): boolean {
  return i.kind === 'permission' || i.kind === 'answer'
}
