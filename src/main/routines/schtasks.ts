// "Wake Lumen for this": a per-user Windows Task Scheduler entry under \Lumen\ that starts
// `Lumen.exe --hidden --run-automation <id>` at the automation's time (installed build only;
// no admin: the task runs as the signed-in user, only while signed in). A running Lumen gets
// the run handed over by the second instance (instance.ts). The task is written as XML
// (/Create /XML) so dates do not depend on the system's date format. The command building is
// pure; WakeTasks runs schtasks.exe through an injected exec.
import type { Automation, TimeTrigger } from '@shared/automations'
import { isTimeTrigger } from './triggers'

export const TASK_FOLDER = 'Lumen'
export const RUN_AUTOMATION_ARG = '--run-automation'
export const HIDDEN_ARG = '--hidden'
const ID_RE = /^(?:au|rt|pr)_[a-z0-9]{4,40}$/

export function taskName(id: string): string {
  return `\\${TASK_FOLDER}\\${id}`
}

export function wakeArgs(id: string): string[] {
  return [HIDDEN_ARG, RUN_AUTOMATION_ARG, id]
}

/** The automation id after --run-automation (validated), or null. */
export function automationIdFromArgv(argv: readonly string[]): string | null {
  const i = argv.indexOf(RUN_AUTOMATION_ARG)
  const id =
    i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`${RUN_AUTOMATION_ARG}=`))?.split('=')[1]
  return id && ID_RE.test(id) ? id : null
}

export function createArgs(id: string, xmlPath: string): string[] {
  return ['/Create', '/F', '/TN', taskName(id), '/XML', xmlPath]
}

export function deleteArgs(id: string): string[] {
  return ['/Delete', '/F', '/TN', taskName(id)]
}

export function queryArgs(): string[] {
  return ['/Query', '/FO', 'CSV', '/NH']
}

/** Ids of Lumen's automation tasks in `schtasks /Query /FO CSV /NH` output. */
export function parseLumenTasks(csv: string): string[] {
  const out = new Set<string>()
  const re = new RegExp(`^"\\\\${TASK_FOLDER}\\\\([a-z0-9_]+)"`, 'i')
  for (const line of csv.split(/\r?\n/)) {
    const m = re.exec(line.trim())
    if (m && ID_RE.test(m[1])) out.add(m[1])
  }
  return [...out]
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local wall-clock "YYYY-MM-DDTHH:MM:SS" (Task Scheduler reads it as local time). */
export function localStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

function stampAt(now: number, at: string): string {
  const [h, m] = at.split(':').map(Number)
  const d = new Date(now)
  return localStamp(new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime())
}

const xmlEscape = (s: string): string =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!
  )

const DAY_TAGS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_TAGS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

function bySchedule(days?: number[]): string {
  const d = [...new Set(days ?? [])].sort()
  if (!d.length || d.length === 7)
    return '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>'
  return `<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek>${d.map((x) => `<${DAY_TAGS[x]} />`).join('')}</DaysOfWeek></ScheduleByWeek>`
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** The <Triggers> body for a time trigger. */
export function triggerXml(t: TimeTrigger, now: number): string {
  switch (t.kind) {
    case 'once':
      return `<TimeTrigger><StartBoundary>${localStamp(t.at)}</StartBoundary><Enabled>true</Enabled></TimeTrigger>`
    case 'daily':
      return `<CalendarTrigger><StartBoundary>${stampAt(now, t.at)}</StartBoundary><Enabled>true</Enabled>${bySchedule(t.days)}</CalendarTrigger>`
    case 'monthly': {
      // Day 31 means the month's last day (as in Lumen); 29 / 30 skip shorter months here.
      const day = t.day >= 31 ? 'Last' : String(t.day)
      return `<CalendarTrigger><StartBoundary>${stampAt(now, t.at)}</StartBoundary><Enabled>true</Enabled><ScheduleByMonth><DaysOfMonth><Day>${day}</Day></DaysOfMonth><Months>${MONTH_TAGS.map((m) => `<${m} />`).join('')}</Months></ScheduleByMonth></CalendarTrigger>`
    }
    case 'every': {
      const from = t.from ?? '00:00'
      // Without a window: all day, repeated from midnight. With one: from … to, `to` included.
      const span = t.from && t.to ? minutesOf(t.to) - minutesOf(t.from) + 1 : 24 * 60
      const duration = span >= 24 * 60 ? 'P1D' : `PT${span}M`
      return `<CalendarTrigger><Repetition><Interval>PT${t.minutes}M</Interval><Duration>${duration}</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${stampAt(now, from)}</StartBoundary><Enabled>true</Enabled>${bySchedule(t.days)}</CalendarTrigger>`
    }
  }
}

/**
 * The task definition. Parallel instances: a second Lumen only hands the run to the open one
 * and quits, and a Lumen the task started keeps running in the tray (no time limit), so the
 * next run must not wait for it.
 */
export function taskXml(
  a: Pick<Automation, 'id' | 'name' | 'trigger'>,
  exe: string,
  now: number
): string | null {
  if (!isTimeTrigger(a.trigger)) return null
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `<RegistrationInfo><Description>${xmlEscape(`Lumen automation: ${a.name}`)}</Description></RegistrationInfo>`,
    `<Triggers>${triggerXml(a.trigger, now)}</Triggers>`,
    '<Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
    '<Settings><MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><AllowHardTerminate>true</AllowHardTerminate><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings>',
    `<Actions Context="Author"><Exec><Command>${xmlEscape(exe)}</Command><Arguments>${wakeArgs(a.id).join(' ')}</Arguments></Exec></Actions>`,
    '</Task>'
  ].join('\r\n')
}

/** Should this automation have a task? */
export function wantsWakeTask(a: Automation): boolean {
  return a.enabled && !!a.wake && isTimeTrigger(a.trigger)
}

// ---- runner ----

export interface WakePorts {
  /** False in dev and the portable build: nothing is ever registered. */
  supported(): boolean
  exe(): string
  /** Runs schtasks.exe with these args (no shell, hidden window). */
  exec(args: string[]): Promise<string>
  /** Writes the XML (UTF-16LE with BOM) to a temp file; returns its path. */
  writeXml(id: string, xml: string): string
  removeXml(path: string): void
  now(): number
  log(msg: string): void
}

export class WakeTasks {
  /** id → the definition registered last. */
  private registered = new Map<string, string>()
  private errors = new Map<string, string>()
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly p: WakePorts) {}

  /** Task Scheduler drives this automation's time trigger right now. */
  active(id: string): boolean {
    return this.registered.has(id)
  }

  error(id: string): string | undefined {
    return this.errors.get(id)
  }

  /** On start: drops tasks of automations that are gone or off, registers the rest. */
  reconcile(list: Automation[]): Promise<void> {
    if (!this.p.supported()) return Promise.resolve()
    return this.queue(async () => {
      let existing: string[] = []
      try {
        existing = parseLumenTasks(await this.p.exec(queryArgs()))
      } catch (e) {
        this.p.log(`wake: query failed: ${(e as Error).message}`)
      }
      const want = new Set(list.filter(wantsWakeTask).map((a) => a.id))
      for (const id of existing) if (!want.has(id)) await this.remove(id)
      for (const a of list) if (wantsWakeTask(a)) await this.create(a)
    })
  }

  /** After a change: registers, re-registers or removes as needed. */
  sync(list: Automation[], removedIds: string[] = []): Promise<void> {
    if (!this.p.supported()) return Promise.resolve()
    return this.queue(async () => {
      for (const id of removedIds)
        if (this.registered.has(id) || this.errors.has(id)) await this.remove(id)
      for (const a of list) {
        if (wantsWakeTask(a)) {
          if (this.registered.get(a.id) !== this.key(a)) await this.create(a)
        } else if (this.registered.has(a.id)) await this.remove(a.id)
        else this.errors.delete(a.id)
      }
    })
  }

  private key(a: Automation): string {
    return JSON.stringify([a.name, a.trigger, this.p.exe()])
  }

  private queue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn, fn)
    return this.chain
  }

  private async create(a: Automation): Promise<void> {
    const xml = taskXml(a, this.p.exe(), this.p.now())
    if (!xml) return
    let path: string | null = null
    try {
      path = this.p.writeXml(a.id, xml)
      await this.p.exec(createArgs(a.id, path))
      this.registered.set(a.id, this.key(a))
      this.errors.delete(a.id)
    } catch (e) {
      this.registered.delete(a.id)
      this.errors.set(
        a.id,
        'Windows did not accept the wake-up task; it runs only while Lumen is open.'
      )
      this.p.log(`wake: create ${a.id} failed: ${(e as Error).message}`)
    } finally {
      if (path) this.p.removeXml(path)
    }
  }

  private async remove(id: string): Promise<void> {
    try {
      await this.p.exec(deleteArgs(id))
    } catch (e) {
      this.p.log(`wake: delete ${id} failed: ${(e as Error).message}`)
    }
    this.registered.delete(id)
    this.errors.delete(id)
  }
}
