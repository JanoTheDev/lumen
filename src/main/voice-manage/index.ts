// Voice management of everything the user made (tasks, automations, skills, buddies, grants,
// the action log, notes, memory, connectors, saved guides, diagnostics): "stop the email task",
// "turn off my morning automation", "delete the invoice skill", "what have I always allowed",
// "read my last note", "export diagnostics". Wired in the query intercept chain before
// interceptLocal: interceptManage returns the answer (or its promise) when the words are ours,
// else undefined. Destructive steps go through the bar's confirm card.
import { app, shell } from 'electron'
import { join } from 'path'
import { chatHeader, chatList, controlChat } from '../agent-mode/transcript-wire'
import { notice } from '../agent-mode/background'
import { grants } from '../agent-mode/grants'
import { describeAuditEntry, listAudit } from '../audit/log'
import { listBuddies, removeBuddy } from '../buddies'
import { connectors } from '../connectors'
import { writeDiagnostics } from '../diagnostics/export'
import { deleteSavedGuide, listSavedGuides } from '../guides/store'
import { DELETE_CONFIRM_WORD, deleteAllMemory, exportMemory } from '../ipc/memory'
import { log } from '../logger'
import { automations } from '../routines'
import { listSkillSummaries, removeSkill, setSkillEnabled } from '../skills'
import { deleteNote, listNotes } from '../speech/dictation/notes'
import * as assistant from '../windows/assistant'
import { broadcast } from '../windows/registry'
import { ManageVoice, type ManageDeps } from './service'

export { parseManageCommand } from './grammar'
export { ManageVoice } from './service'

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10)

/** Audit lines between two times (day files are named by UTC date). */
function auditBetween(from: number, to: number): { ok: boolean; text: string }[] {
  const days = new Set<string>()
  for (let t = from; t < to; t += 6 * 3_600_000) days.add(utcDay(t))
  days.add(utcDay(to - 1))
  const out: { ok: boolean; text: string; t: number }[] = []
  for (const d of [...days].sort())
    for (const e of listAudit(d)) {
      const t = Date.parse(e.t)
      if (t >= from && t < to) out.push({ ok: e.result === 'ok', text: describeAuditEntry(e), t })
    }
  return out.sort((a, b) => a.t - b.t).map(({ ok, text }) => ({ ok, text }))
}

function downloads(): string {
  return app.getPath('downloads')
}

const deps: ManageDeps = {
  now: () => Date.now(),
  confirm: (summary, risk) => assistant.requestConfirm({ summary, risk }),
  confirmPending: () => assistant.confirmPending(),
  tasks: {
    list: () => chatList(),
    header: (id) => chatHeader(id),
    control: (id, op, token) => controlChat(id, op, token)
  },
  automations: {
    list: () => automations().list(),
    setEnabled: (id, on) => automations().update(id, { enabled: on }),
    remove: (id) => automations().remove(id),
    runNow: (id) => automations().runNow(id)
  },
  buddies: {
    list: () => listBuddies().map((b) => ({ id: b.id, name: b.name })),
    remove: (id) => removeBuddy(id)
  },
  skills: {
    list: () => listSkillSummaries(),
    setEnabled: (name, on) => setSkillEnabled(name, on),
    remove: (name) => removeSkill(name)
  },
  grants: {
    list: () => grants().list(),
    revoke: (scope) => grants().revoke(scope)
  },
  audit: { entries: auditBetween },
  notes: {
    list: () => listNotes(),
    remove: (id) => deleteNote(id)
  },
  memory: {
    export: () => exportMemory(downloads()),
    deleteAll: () => {
      const r = deleteAllMemory(DELETE_CONFIRM_WORD)
      if (r.ok)
        try {
          broadcast('memory:changed', { pending: 0 })
        } catch {
          // windows not up yet
        }
      return r
    }
  },
  connectors: {
    list: () => connectors().list(),
    test: (id) => connectors().test(id),
    signIn: (id) =>
      connectors().signIn(id, {
        open: (url) => shell.openExternal(url.toString())
      }),
    notify: (text) => notice(text)
  },
  guides: {
    list: () => listSavedGuides().map((g) => ({ id: g.id, name: g.name })),
    remove: (id) => deleteSavedGuide(id)
  },
  diagnostics: {
    export: async () => {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const file = join(downloads(), `Lumen-diagnostics-${stamp}.zip`)
      try {
        await writeDiagnostics(file)
        log('done', `[diag] diagnostics written to ${file}`)
        return { ok: true, path: file }
      } catch (e) {
        log('fail', `[diag] export failed: ${(e as Error).message}`)
        return { ok: false, error: 'I couldn’t write the diagnostics file.' }
      }
    }
  }
}

let voice: ManageVoice | null = null

/**
 * Whole-utterance management commands: the answer (or a promise of it) when the words are
 * ours, undefined to go on with the chain.
 */
export function interceptManage(prompt: string): unknown | undefined {
  voice ??= new ManageVoice(deps)
  try {
    return voice.turn(prompt) ?? undefined
  } catch (e) {
    log('fail', `voice manage: ${(e as Error).message}`)
    return undefined
  }
}

/** Rows for the voice help sheet. */
export function manageVoiceHelp(): { say: string; does: string }[] {
  return [
    { say: 'What are you working on?', does: 'List the tasks that are running or waiting' },
    { say: 'Stop the email task', does: 'Stop a task by name (also pause, resume)' },
    { say: 'Run the price check task again', does: 'Start a finished task again' },
    { say: 'Stop all background tasks', does: 'Stop every running task (also pause, resume)' },
    { say: 'What’s the email task asking?', does: 'Read a waiting task’s question' },
    { say: 'Approve it / deny it', does: 'Answer the one task that is waiting' },
    { say: 'Turn off my morning automation', does: 'Turn an automation off or on' },
    { say: 'Delete the morning automation', does: 'Delete an automation (asks first)' },
    { say: 'Run the morning automation now', does: 'Run an automation once now' },
    { say: 'What skills do I have?', does: 'List your skills' },
    { say: 'Turn off the invoice skill', does: 'Turn a skill off or on' },
    { say: 'Delete the invoice skill', does: 'Delete a skill (asks first)' },
    { say: 'Delete Inbox Buddy', does: 'Delete a buddy (asks first)' },
    { say: 'What have I always allowed?', does: 'List your always-allow permissions' },
    { say: 'Stop always allowing Outlook', does: 'Take one permission back' },
    { say: 'Revoke all permissions', does: 'Take every always-allow back (asks first)' },
    { say: 'What did you do today?', does: 'Sum up the actions Lumen took today' },
    { say: 'Read my notes / read my last note', does: 'Read your newest notes' },
    { say: 'Delete my last note', does: 'Delete your newest note (asks first)' },
    { say: 'Export my memory', does: 'Save what Lumen remembers to Downloads' },
    { say: 'Forget everything about me', does: 'Delete all memory (asks first)' },
    { say: 'What connectors do I have?', does: 'List your connectors' },
    { say: 'Test my GitHub connector', does: 'Check that a connector works' },
    { say: 'Sign in to GitHub', does: 'Open a connector’s sign-in page' },
    { say: 'List my guides', does: 'List your saved guides' },
    { say: 'Delete the printer guide', does: 'Delete a saved guide (asks first)' },
    { say: 'Export diagnostics', does: 'Save a bug report file to Downloads' }
  ]
}
