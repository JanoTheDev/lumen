// Automation drafts: what the confirm card says before an automation is saved, the pre-approval
// choices it offers (mouse and keyboard, connectors) and the fast-model fallback for a request
// the local grammar (parse.ts) could not read. The model only rewrites the request into a
// "when" phrase and a "what"; the trigger itself is always parsed locally.
import { z } from 'zod'
import type { AutomationAction, AutomationDraft, AutomationTrigger } from '@shared/automations'
import { parseTriggerText, type ParseOpts } from './parse'
import { reminderLine } from './proactive'
import { describeAutomation, folderName } from './triggers'

const FOREGROUND_RE =
  /\b(?:click|type|typing|rename|move|drag|fill (?:in|out)|press|organi[sz]e|sort|tidy|clean up|close|launch|save a copy|open (?:the |my |a )?(?:app|program|file|folder|document|spreadsheet)|in (?:excel|word|explorer|outlook|photoshop|blender))\b/i
const CONNECTOR_RE =
  /\b(?:send|e-?mail|mail|inbox|post|reply|calendar|slack|discord|message|tweet|delete|pay|invoice|upload)\b/i

/** Risky things an action may need: each becomes a pre-approval choice. */
export function wantsFor(action: AutomationAction): AutomationDraft['wants'] {
  // A buddy's own permissions decide what it may do (08 T52).
  if (action.kind === 'remind' || action.kind === 'buddy')
    return { foreground: false, connectors: false }
  const text = action.kind === 'task' ? action.prompt : `${action.skill} ${action.prompt ?? ''}`
  return { foreground: FOREGROUND_RE.test(text), connectors: CONNECTOR_RE.test(text) }
}

export function draftName(action: AutomationAction, title: (s: string) => string): string {
  if (action.kind === 'remind') return title(action.say)
  if (action.kind === 'skill') return title(`Skill ${action.skill}`)
  if (action.kind === 'buddy') return title(`Buddy ${action.buddyId}`)
  return title(action.prompt)
}

/** The plain-language confirm text. */
export function draftSummary(
  d: Pick<AutomationDraft, 'trigger' | 'action' | 'shareFolder'>
): string {
  const parts = [describeAutomation(d.trigger, d.action)]
  if (d.shareFolder)
    parts.push(`This lets background tasks read the ${folderName(d.shareFolder)} folder.`)
  if (d.action.kind !== 'remind')
    parts.push('It runs in the background while Lumen is open; results wait in the Tasks list.')
  return parts.join(' ')
}

export function makeDraft(
  trigger: AutomationTrigger,
  action: AutomationAction,
  title: (s: string) => string,
  granted: (folder: string) => boolean
): AutomationDraft {
  const shareFolder =
    trigger.kind === 'file' && !granted(trigger.folder) ? trigger.folder : undefined
  const base = { trigger, action, ...(shareFolder ? { shareFolder } : {}) }
  return {
    ...base,
    name: draftName(action, title),
    summary: draftSummary(base),
    wants: wantsFor(action)
  }
}

/** Second confirm: the pre-approval question, or null when nothing risky is wanted. */
export function preapprovalQuestion(w: AutomationDraft['wants']): string | null {
  const what = [
    w.foreground ? 'use the mouse and keyboard' : '',
    w.connectors ? 'use your connected apps (for example send or post)' : ''
  ].filter(Boolean)
  if (!what.length) return null
  return `It may need to ${what.join(' and ')}. Allow that without asking? It only uses the mouse while you are at the PC. You can change this in Settings, Automations.`
}

// ---- model fallback ----

export const DRAFT_SYSTEM = `You turn a user's request into an automation for a desktop assistant. Reply with JSON only.
Fields:
- automation: true when the request asks for something to happen automatically later, repeatedly or on an event; else false.
- when: the trigger as ONE short English phrase in exactly one of these forms:
  "every day at 09:00", "every weekday at 09:00", "every monday and friday at 08:30", "every 30 minutes", "every hour between 9 and 17", "every month on the 1st at 09:00", "tomorrow at 08:00", "today at 17:00", "in 20 minutes", "on friday at 10:00", "when lumen starts", "when i open <app>", "when i close <app>", "when a pdf lands in downloads", "when a file lands in <folder>", "when a file in <folder> changes", "when i'm idle for 10 minutes", "when i'm back", "when the internet comes back".
- what: the task in the user's own words, as an imperative ("summarize my unread mail"), or the reminder text for kind remind.
- kind: "remind" when the user only wants to be reminded or told something, "skill" when they name one of the listed skills, else "task".
- skill: the skill's exact name for kind skill, else "".
- reason: when automation is false or something is missing, one short question to ask the user, else "".
Never invent a time the user did not say unless the request implies one (for "every morning" use 08:00).`

export const draftReplySchema = z.object({
  automation: z.boolean(),
  when: z.string().max(200),
  what: z.string().max(2000),
  kind: z.enum(['task', 'remind', 'skill']),
  skill: z.string().max(80),
  reason: z.string().max(300)
})
export type DraftReply = z.infer<typeof draftReplySchema>

export function draftUserTurn(request: string, skills: string[], now: number): string {
  const d = new Date(now)
  const day = d.toLocaleDateString('en-US', { weekday: 'long' })
  const lines = [
    `Now: ${day} ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} (local time).`,
    skills.length ? `Skills: ${skills.slice(0, 40).join(', ')}` : 'Skills: none',
    `Request: ${request.slice(0, 1000)}`
  ]
  return lines.join('\n')
}

/** The model's reply → trigger + action (the trigger parsed locally), or a reason. */
export function fromReply(
  r: DraftReply,
  opts: ParseOpts,
  skillExists: (name: string) => boolean
):
  | { ok: true; trigger: AutomationTrigger; action: AutomationAction }
  | { ok: false; reason: string } {
  if (!r.automation)
    return { ok: false, reason: r.reason || 'I could not turn that into an automation.' }
  const t = parseTriggerText(r.when, opts)
  if (!t.ok)
    return {
      ok: false,
      reason: r.reason || 'When should it run? For example “every weekday at 9”.'
    }
  const what = r.what.trim()
  if (!what) return { ok: false, reason: r.reason || 'What should it do?' }
  if (r.kind === 'remind')
    return {
      ok: true,
      trigger: t.trigger,
      action: { kind: 'remind', say: reminderLine('say', what) }
    }
  if (r.kind === 'skill' && r.skill && skillExists(r.skill))
    return { ok: true, trigger: t.trigger, action: { kind: 'skill', skill: r.skill, prompt: what } }
  return { ok: true, trigger: t.trigger, action: { kind: 'task', prompt: what } }
}
