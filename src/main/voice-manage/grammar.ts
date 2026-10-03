// Managing what the user made, by voice: whole-utterance phrases only, so questions that merely
// mention these words ("how do I delete a skill in Photoshop") stay normal requests. Pure; the
// spoken names are resolved against the live lists in service.ts.

export type TaskOp = 'stop' | 'pause' | 'resume' | 'run-again'

export type ManageCommand =
  // background and foreground tasks
  | { kind: 'tasks-list' }
  | { kind: 'task-control'; op: TaskOp; name: string }
  | { kind: 'tasks-all'; op: Exclude<TaskOp, 'run-again'>; background: boolean }
  /** name '' = whichever task is waiting. */
  | { kind: 'task-question'; name: string }
  | { kind: 'task-answer'; approve: boolean; name: string }
  // automations
  | { kind: 'automation-enable'; name: string; on: boolean }
  | { kind: 'automation-delete'; name: string }
  /** loose: "run X now" without the word automation (only when X is an automation, not a buddy). */
  | { kind: 'automation-run'; name: string; loose: boolean }
  // skills
  | { kind: 'skills-list' }
  | { kind: 'skill-enable'; name: string; on: boolean }
  | { kind: 'skill-delete'; name: string }
  // buddies
  | { kind: 'buddy-delete'; name: string }
  // always-allow grants
  | { kind: 'grants-list' }
  | { kind: 'grant-revoke'; name: string }
  | { kind: 'grants-revoke-all' }
  // the action log
  | { kind: 'audit-day'; day: 'today' | 'yesterday' }
  // notes
  | { kind: 'notes-read'; last: boolean }
  | { kind: 'note-delete-last' }
  // memory
  | { kind: 'memory-export' }
  | { kind: 'memory-delete-all' }
  // connectors
  | { kind: 'connectors-list' }
  | { kind: 'connector-test'; name: string }
  /** loose: no word "connector" (only when the name is one of the user's connectors). */
  | { kind: 'connector-sign-in'; name: string; loose: boolean }
  // saved guides
  | { kind: 'guides-list' }
  | { kind: 'guide-delete'; name: string }
  // diagnostics
  | { kind: 'diagnostics-export' }

/** Lowercase words, apostrophes dropped ("what's" → whats), wake words and "please" trimmed. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:hey|ok|okay) lumen |lumen |ok |okay |please )+/, '')
    .replace(/^(?:can|could|would|will) you (?:please )?/, '')
    .replace(/ please$/, '')
    .trim()
}

const NOT_A_NAME =
  /^(?:it|that|this|these|those|the|my|a|an|all|any|every|each|last|the last|new|one|some|your)$/

/** The spoken name without leading "the" / "my" and trailing "one"; null when it says nothing. */
function cleanName(s: string | undefined): string | null {
  if (!s) return null
  const n = s
    .replace(/^(?:the|my|our) /, '')
    .replace(/ one$/, '')
    .trim()
  if (!n || NOT_A_NAME.test(n) || n.split(' ').length > 8) return null
  return n
}

/**
 * `<verb> [the|my] <name> <noun>` or `<verb> [the|my] <noun> [called|named] <name>`; the name,
 * or null when the words are not that shape.
 */
function verbNoun(n: string, verbs: string, noun: string): string | null {
  const m = new RegExp(
    `^(?:${verbs}) (?:the |my )?(?:(.+?) ${noun}|${noun} (?:called |named )?(.+))$`
  ).exec(n)
  return m ? cleanName(m[1] ?? m[2]) : null
}

/** "turn off the X <noun>", "turn the X <noun> off", "disable the X <noun>": [name, on]. */
function onOff(n: string, noun: string): [string, boolean] | null {
  let m = new RegExp(`^(?:turn|switch) (off|on) (?:the |my )?(.+?) ${noun}$`).exec(n)
  if (m) {
    const name = cleanName(m[2])
    return name ? [name, m[1] === 'on'] : null
  }
  m = new RegExp(`^(?:turn|switch) (?:the |my )?(.+?) ${noun} (off|on|back on)$`).exec(n)
  if (m) {
    const name = cleanName(m[1])
    return name ? [name, m[2] !== 'off'] : null
  }
  m = new RegExp(
    `^(disable|deactivate|pause|enable|activate|resume|unpause) (?:the |my )?(.+?) ${noun}$`
  ).exec(n)
  if (m) {
    const name = cleanName(m[2])
    return name ? [name, !/^(?:disable|deactivate|pause)$/.test(m[1])] : null
  }
  return null
}

const DELETE = 'delete|remove|erase|get rid of|cancel|uninstall'

const TASK = '(?:background )?(?:task|job)'
const AUTOMATION = '(?:automation|routine|reminder)'

const TASKS_LIST_RE =
  /^(?:what are you (?:working on|busy with|doing in the background)|whats running|what is running|what tasks (?:are running|do i have|are there)|(?:list|tell me) (?:all )?(?:of )?(?:my |the )?(?:background )?tasks|what are my tasks)(?: right now| now)?$/
const TASKS_ALL_RE =
  /^(stop|cancel|abort|pause|resume|unpause|continue) (?:all|every)(?: of)? (?:my |the )?(background )?tasks?$/
const TASK_OP_RE = new RegExp(
  `^(stop|cancel|abort|end|kill|pause|resume|unpause|continue) (?:the |my )?(.+?) ${TASK}$`
)
const TASK_AGAIN_RE = new RegExp(
  `^(?:run|do|start) (?:the |my )?(.+?) ${TASK} again$|^(?:rerun|restart|redo) (?:the |my )?(.+?) ${TASK}$`
)
const TASK_ASKING_RE = new RegExp(
  `^(?:whats|what is|what does) (?:the |my )?(?:(.*?) )?${TASK} (?:asking(?: me)?(?: for| about)?|want(?: from me)?|need(?: from me)?|waiting for)$`
)
const ANY_ASKING_RE =
  /^(?:is (?:anything|any task|something) waiting for me|whats waiting for me|what is waiting for me|what are (?:my |the )?tasks asking(?: me)?(?: for)?)$/
const ANSWER_IT_RE = /^(approve|accept|deny|decline|reject) (?:it|that|this|the request)$/
const ANSWER_TASK_RE = new RegExp(
  `^(approve|accept|deny|decline|reject) (?:the |my )?(.+?) ${TASK}(?:s request)?$`
)

const OP: Record<string, TaskOp> = {
  stop: 'stop',
  cancel: 'stop',
  abort: 'stop',
  end: 'stop',
  kill: 'stop',
  pause: 'pause',
  resume: 'resume',
  unpause: 'resume',
  continue: 'resume'
}

const SKILLS_LIST_RE =
  /^(?:(?:what|which) skills (?:do i have|have i got|are there|are installed|do you have)|(?:list|tell me) (?:all )?(?:of )?my skills|what are my skills)$/

const GRANTS_LIST_RE =
  /^(?:what (?:have|did|do) i (?:always allowed|always allow)(?: you to do)?|what do you always allow|what are you always allowed to do|(?:list|tell me) (?:all )?(?:of )?my (?:always allow |saved )?(?:permissions|grants)|what permissions (?:have i given|did i give|do you have)(?: you)?)$/
const GRANTS_REVOKE_ALL_RE =
  /^(?:(?:revoke|remove|clear|reset|forget|delete) (?:all|every)(?: of)? (?:my |the |your )?(?:always allow |saved )?(?:permissions?|grants?|always allows?)|stop always allowing (?:everything|anything))$/
const GRANT_REVOKE_RE =
  /^(?:stop always allowing|dont always allow|do not always allow|no longer always allow|revoke(?: the)?(?: permission| grant| access)?(?: for| to use| to)?) (.+?)(?: permission| grant)?$/

const AUDIT_RE =
  /^what (?:did|have) you (?:do|done)(?: on my (?:computer|pc|screen)| for me)? (today|yesterday)$/

const NOTES_READ_RE =
  /^(?:(?:read|tell) (?:me )?(?:all )?(?:of )?(?:my|the) notes|what are my notes|what notes do i have)$/
const NOTE_LAST_RE =
  /^(?:(?:read|tell) (?:me )?(?:my|the) (?:last|latest|newest|most recent) note|what was my (?:last|latest) note)$/
const NOTE_DELETE_LAST_RE =
  /^(?:delete|remove|erase|throw away) (?:my|the) (?:last|latest|newest|most recent) note$/

const MEMORY_EXPORT_RE =
  /^(?:export|download|back up|backup|save a copy of) (?:all )?(?:of )?(?:my |your )?memor(?:y|ies)(?: about me)?$/
const MEMORY_DELETE_RE =
  /^(?:forget everything(?: you know)? about me|(?:delete|erase|wipe|clear) (?:all )?(?:of )?(?:my |your )?memor(?:y|ies)(?: about me)?|(?:delete|erase|wipe) everything you (?:know|remember) about me)$/

const CONNECTORS_LIST_RE =
  /^(?:(?:what|which) connectors (?:do i have|are there|are set up|are connected)|(?:list|tell me) (?:all )?(?:of )?my connectors|what are my connectors)$/
const CONNECTOR_SIGN_IN_RE = /^(?:sign|log) ?in(?:to| to| with) (?:the |my )?(.+?)( connector)?$/
const CONNECT_RE = /^connect (?:to )?(?:the |my )?(.+?)( connector)?$/

const GUIDES_LIST_RE =
  /^(?:(?:list|tell me) (?:all )?(?:of )?my (?:saved )?guides|(?:what|which) (?:saved )?guides (?:do i have|have i saved)|what are my (?:saved )?guides)$/

const DIAGNOSTICS_RE =
  /^(?:(?:export|save|make|create|write)(?: me)? (?:a |the )?diagnostics?(?: file| zip| report)?|(?:send|make|create|save|export|write)(?: me)? (?:a )?bug report(?: file)?)$/

const BUDDY_WORD = '(?:buddy|buddie|body)'

/** The management command in these words, or null when they are not one. */
export function parseManageCommand(text: string): ManageCommand | null {
  const n = normalize(text)
  if (!n || n.length > 200) return null

  // ---- tasks ----
  if (TASKS_LIST_RE.test(n)) return { kind: 'tasks-list' }
  let m = TASKS_ALL_RE.exec(n)
  if (m) {
    const op = OP[m[1]] as Exclude<TaskOp, 'run-again'>
    return { kind: 'tasks-all', op, background: !!m[2] }
  }
  m = TASK_AGAIN_RE.exec(n)
  if (m) {
    const name = cleanName(m[1] ?? m[2])
    return name ? { kind: 'task-control', op: 'run-again', name } : null
  }
  if (ANY_ASKING_RE.test(n)) return { kind: 'task-question', name: '' }
  m = TASK_ASKING_RE.exec(n)
  if (m) return { kind: 'task-question', name: cleanName(m[1]) ?? '' }
  m = ANSWER_IT_RE.exec(n)
  if (m) return { kind: 'task-answer', approve: /^(?:approve|accept)$/.test(m[1]), name: '' }
  m = ANSWER_TASK_RE.exec(n)
  if (m) {
    const name = cleanName(m[2])
    if (name) return { kind: 'task-answer', approve: /^(?:approve|accept)$/.test(m[1]), name }
  }
  m = TASK_OP_RE.exec(n)
  if (m) {
    // "stop the task" / "pause the background task": the running task's own words (session.ts).
    const name = cleanName(m[2])
    if (name && !/^(?:background|current|running|foreground|agent)$/.test(name))
      return { kind: 'task-control', op: OP[m[1]], name }
    return null
  }

  // ---- automations ----
  const autoOnOff = onOff(n, AUTOMATION)
  if (autoOnOff) return { kind: 'automation-enable', name: autoOnOff[0], on: autoOnOff[1] }
  let name = verbNoun(n, DELETE, AUTOMATION)
  if (name) return { kind: 'automation-delete', name }
  name = verbNoun(n, 'run|trigger|start', `${AUTOMATION}(?: now| right now)?`)
  if (name) return { kind: 'automation-run', name, loose: false }

  // ---- skills ----
  if (SKILLS_LIST_RE.test(n)) return { kind: 'skills-list' }
  const skillOnOff = onOff(n, 'skill')
  if (skillOnOff) return { kind: 'skill-enable', name: skillOnOff[0], on: skillOnOff[1] }
  name = verbNoun(n, DELETE, 'skill')
  if (name) return { kind: 'skill-delete', name }

  // ---- grants ----
  if (GRANTS_LIST_RE.test(n)) return { kind: 'grants-list' }
  if (GRANTS_REVOKE_ALL_RE.test(n)) return { kind: 'grants-revoke-all' }
  m = GRANT_REVOKE_RE.exec(n)
  if (m) {
    const g = cleanName(m[1])
    if (g) return { kind: 'grant-revoke', name: g }
  }

  // ---- audit, notes, memory ----
  m = AUDIT_RE.exec(n)
  if (m) return { kind: 'audit-day', day: m[1] as 'today' | 'yesterday' }
  if (NOTES_READ_RE.test(n)) return { kind: 'notes-read', last: false }
  if (NOTE_LAST_RE.test(n)) return { kind: 'notes-read', last: true }
  if (NOTE_DELETE_LAST_RE.test(n)) return { kind: 'note-delete-last' }
  if (MEMORY_EXPORT_RE.test(n)) return { kind: 'memory-export' }
  if (MEMORY_DELETE_RE.test(n)) return { kind: 'memory-delete-all' }

  // ---- connectors ----
  if (CONNECTORS_LIST_RE.test(n)) return { kind: 'connectors-list' }
  name = verbNoun(n, 'test|check|try', 'connector')
  if (name) return { kind: 'connector-test', name }
  m = CONNECTOR_SIGN_IN_RE.exec(n) ?? CONNECT_RE.exec(n)
  if (m) {
    const c = cleanName(m[1])
    if (c) return { kind: 'connector-sign-in', name: c, loose: !m[2] }
  }

  // ---- guides, diagnostics ----
  if (GUIDES_LIST_RE.test(n)) return { kind: 'guides-list' }
  name = verbNoun(n, DELETE, '(?:saved )?guide')
  if (name) return { kind: 'guide-delete', name }
  if (DIAGNOSTICS_RE.test(n)) return { kind: 'diagnostics-export' }

  // ---- buddies (after every other noun: "delete the buddy skill" is a skill) ----
  m = new RegExp(
    `^(?:${DELETE}) (?:the |my )?(?:(.+? ${BUDDY_WORD})|${BUDDY_WORD} (?:called |named )?(.+))$`
  ).exec(n)
  if (m) {
    const b = cleanName(m[1] ?? m[2])
    if (b && !new RegExp(`^${BUDDY_WORD}$`).test(b)) return { kind: 'buddy-delete', name: b }
  }

  // "run the morning briefing now": an automation's name (service.ts checks it is one).
  m = /^(?:run|trigger) (?:the |my )?(.+?) (?:now|right now)$/.exec(n)
  if (m) {
    const a = cleanName(m[1])
    if (a) return { kind: 'automation-run', name: a, loose: true }
  }
  return null
}
