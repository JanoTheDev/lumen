// Applies a parsed settings command. Everything outside is a port (config, patchConfig, the
// confirm card, the panel window, voices, updates), so this stays testable without Electron.
// Patches are as small as the patch schema allows: top-level sections are partial one level
// down, so a deeper key (a11y.switch.enabled, a11y.face.enabled) is sent with its siblings.
import type { AppConfig } from '../config'
import type { UpdateStatus } from '@shared/channels'
import type { SettingsCommand, SettingsSection, SetOp } from './grammar'
import {
  LANGUAGE_WORDS,
  rowById,
  type BoolRow,
  type EnumRow,
  type NumberRow,
  type RowConfirm,
  type SettingRow
} from './table'

export interface VoiceInfo {
  /** Saved as voice.ttsVoice. */
  name: string
  lang: string
  gender?: 'male' | 'female' | 'unknown'
}

export interface SettingsPorts {
  config(): AppConfig
  /** patchConfig: validates, saves, re-applies and broadcasts. */
  patch(p: Record<string, unknown>): Promise<unknown>
  confirm(c: RowConfirm): Promise<boolean>
  openPanel(route: string): void
  faceInstalled(): boolean
  /** The voice language can be heard (offline model, or cloud speech with a key). */
  canHear(lang: string, cfg: AppConfig): boolean
  /** Voices of the engine in use; the current one (null = unknown). */
  voices(): Promise<{ list: VoiceInfo[]; current: VoiceInfo | null; engine: 'windows' | 'cloud' }>
  update: {
    status(): UpdateStatus
    check(): Promise<UpdateStatus>
    install(): { ok: boolean }
  } | null
}

const SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'General',
  voice: 'Voice',
  accessibility: 'Accessibility',
  look: 'Buddy and look',
  models: 'Models and keys',
  usage: 'Usage',
  memory: 'Memory',
  lessons: 'Lessons',
  skills: 'Skills',
  background: 'Automations',
  buddies: 'Buddies',
  helpers: 'Smart helpers',
  bridges: 'App helpers',
  'claude-code': 'Claude Code',
  connectors: 'Connectors',
  news: 'News and reading',
  privacy: 'Privacy',
  diagnostics: 'Diagnostics',
  about: 'About'
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

export function readPath(cfg: unknown, path: readonly string[]): unknown {
  let cur: unknown = cfg
  for (const k of path) cur = isObj(cur) ? cur[k] : undefined
  return cur
}

/** The patch that sets `path` to `value`: the top section and its first key partial, deeper
 * objects sent whole (current values spread in). */
export function patchFor(
  cfg: unknown,
  path: readonly string[],
  value: unknown
): Record<string, unknown> {
  const build = (obj: unknown, i: number): unknown => {
    if (i === path.length) return value
    const key = path[i]
    const child = build(isObj(obj) ? obj[key] : undefined, i + 1)
    const keep = i >= 2 && isObj(obj) ? obj : {}
    return { ...keep, [key]: child }
  }
  return build(cfg, 0) as Record<string, unknown>
}

const quote = (s: string): string => `“${s}”`

/** "in Lumen" for names an app could also mean, so the undo sentence parses back. */
const scopeTail = (row: SettingRow): string => (row.scope === 'ambiguous' ? ' in Lumen' : '')

export function undoSentence(row: SettingRow, nowOn: boolean): string {
  return `turn ${nowOn ? 'off' : 'on'} ${row.names[0]}${scopeTail(row)}`
}

function isOnValue(row: BoolRow, v: unknown): boolean {
  return row.isOn ? row.isOn(v) : v === true
}

async function confirmFirst(ports: SettingsPorts, c: RowConfirm | undefined): Promise<boolean> {
  return c ? ports.confirm(c) : true
}

async function setBool(row: BoolRow, on: boolean, ports: SettingsPorts): Promise<string> {
  const cfg = ports.config()
  const cur = readPath(cfg, row.path)
  if (isOnValue(row, cur) === on) return `${row.label} is already ${on ? 'on' : 'off'}.`
  if (row.id === 'face-gestures' && on && !ports.faceInstalled())
    return 'Face gestures need the face model first. Download it in Settings, Accessibility, face gestures.'
  if (!(await confirmFirst(ports, on ? row.confirmOn : row.confirmOff)))
    return `Okay, ${row.label.toLowerCase()} stays ${on ? 'off' : 'on'}.`
  const value = on
    ? typeof row.on === 'function'
      ? (row.on as (c: unknown) => unknown)(cur)
      : (row.on ?? true)
    : (row.off ?? false)
  await ports.patch(patchFor(cfg, row.path, value))
  let extra = ''
  if (row.id === 'switch-access' && on) {
    const keys = cfg.a11y.switch.keys
    extra = ` Your switch ${keys.length > 1 ? 'keys are' : 'key is'} ${keys.join(' and ')}.`
  }
  return `${row.label} ${on ? 'on' : 'off'}.${extra} Say ${quote(undoSentence(row, on))} to undo.`
}

function enumUndo(row: EnumRow, prev: EnumRow['values'][number]): string {
  if (row.id === 'language') return `speak ${prev.label}`
  if (row.id === 'talk-mode') return `use ${prev.label}`
  return `set your ${row.names[0]} to ${prev.words[0]}`
}

async function setEnum(row: EnumRow, to: unknown, ports: SettingsPorts): Promise<string> {
  const cfg = ports.config()
  const cur = readPath(cfg, row.path)
  const target = row.values.find((v) => v.value === to)
  if (!target) return 'I can’t set that.'
  if (cur === target.value) return `${row.label} is already ${target.label}.`
  if (row.id === 'language' && !ports.canHear(String(to), cfg))
    return `I can’t understand ${target.label} on this PC yet: it needs an OpenAI key for speech recognition. The language stays the same.`
  if (!(await confirmFirst(ports, row.confirm?.[String(target.value)])))
    return `Okay, ${row.label.toLowerCase()} stays the same.`
  await ports.patch(patchFor(cfg, row.path, target.value))
  const prev = row.values.find((v) => v.value === cur)
  const back = prev ? ` Say ${quote(enumUndo(row, prev))} to go back.` : ''
  if (row.id === 'language')
    return to === 'auto'
      ? `I’ll answer in the language you speak.${back}`
      : `I’ll speak ${target.label} now.${back}`
  return `${row.label}: ${target.label}.${back}`
}

const roundTo = (n: number, step: number): number => Math.round(n / step) * step

async function setNumber(row: NumberRow, op: SetOp, ports: SettingsPorts): Promise<string> {
  const cfg = ports.config()
  const raw = readPath(cfg, row.path)
  const cur = typeof raw === 'number' ? raw : row.reset
  let next: number
  if ('step' in op) next = roundTo(cur, row.step) + op.step * row.step
  else if ('reset' in op) next = row.reset
  else if ('number' in op) next = op.percent || op.number > row.max ? op.number / 100 : op.number
  else return 'I can’t set that.'
  next = Number(Math.min(row.max, Math.max(row.min, next)).toFixed(4))
  if (next === cur) {
    if ('step' in op)
      return `${row.label} is already at the ${op.step > 0 ? 'most' : 'least'}: ${row.fmt(cur)}.`
    return `${row.label} is already ${row.fmt(cur)}.`
  }
  await ports.patch(patchFor(cfg, row.path, next))
  const back = next > cur ? row.sayLess : row.sayMore
  const undo = 'step' in op ? back : row.sayReset
  return `${row.label} ${row.fmt(next)}. Say ${quote(undo)} to go back.`
}

function describe(row: SettingRow, cfg: AppConfig): string {
  const v = readPath(cfg, row.path)
  if (row.kind === 'bool') return `${row.label} is ${isOnValue(row, v) ? 'on' : 'off'}.`
  if (row.kind === 'number')
    return `${row.label} is ${row.fmt(typeof v === 'number' ? v : row.reset)}.`
  const hit = row.values.find((x) => x.value === v)
  if (row.id === 'language')
    return v === 'auto'
      ? 'I answer in the language you speak.'
      : `I’m speaking ${hit?.label ?? LANGUAGE_WORDS.en.label}.`
  if (row.id === 'accent' && v === undefined) return 'The accent colour is the theme’s own.'
  return `${row.label} is ${hit?.label ?? String(v)}.`
}

/** "Microsoft Zira Desktop - English (United States)" → "Zira". */
export function shortVoiceName(name: string): string {
  return (
    name
      .replace(/\s+-\s+.*$/, '')
      .replace(/^Microsoft\s+/i, '')
      .replace(/\s+(?:Desktop|Online.*)$/i, '')
      .trim() || name
  )
}

const listOf = (items: string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** The voice a spoken name picks: a gender, "next", or a word of its name. Pure. */
export function chooseVoice(
  said: string,
  list: readonly VoiceInfo[],
  current: VoiceInfo | null,
  lang: string
): VoiceInfo | null {
  const base = lang.split('-')[0]
  const local = list.filter((v) => base === 'auto' || v.lang.toLowerCase().split('-')[0] === base)
  const pool = local.length ? local : list
  if (said === 'male' || said === 'female')
    return (
      pool.find((v) => v.gender === said && v.name !== current?.name) ??
      pool.find((v) => v.gender === said) ??
      null
    )
  if (said === 'next') {
    if (!pool.length) return null
    const i = pool.findIndex((v) => v.name === current?.name)
    return pool[(i + 1) % pool.length]
  }
  const words = said.split(' ')
  const fits = (v: VoiceInfo): boolean => {
    const name = v.name.toLowerCase()
    return words.every((w) => new RegExp(`\\b${w}\\b`).test(name))
  }
  return pool.find(fits) ?? list.find(fits) ?? null
}

async function setVoice(
  cmd: Extract<SettingsCommand, { kind: 'voice' }>,
  ports: SettingsPorts
): Promise<string> {
  const cfg = ports.config()
  let voices: Awaited<ReturnType<SettingsPorts['voices']>>
  try {
    voices = await ports.voices()
  } catch {
    return 'I can’t read the list of voices right now.'
  }
  const pick = chooseVoice(cmd.name, voices.list, voices.current, cfg.voice.language)
  const names = voices.list.map((v) => shortVoiceName(v.name))
  if (!pick)
    return names.length
      ? `I don’t have ${cmd.name === 'male' || cmd.name === 'female' ? `a ${cmd.name}` : `a voice called ${cmd.name}`}. I have ${listOf(names.slice(0, 8))}.`
      : 'I can’t find any voices on this PC.'
  if (pick.name === cfg.voice.ttsVoice || pick.name === voices.current?.name)
    return `I’m already using ${shortVoiceName(pick.name)}.`
  await ports.patch(patchFor(cfg, ['voice', 'ttsVoice'], pick.name))
  const before = voices.current ? shortVoiceName(voices.current.name) : ''
  const off =
    cfg.voice.tts === 'off'
      ? ' Spoken replies are off: say “turn on spoken replies” to hear it.'
      : ''
  return `Voice: ${shortVoiceName(pick.name)}.${off}${before ? ` Say ${quote(`use the voice ${before.toLowerCase()}`)} to go back.` : ''}`
}

async function listVoices(ports: SettingsPorts, which: 'list' | 'current'): Promise<string> {
  try {
    const v = await ports.voices()
    if (which === 'current')
      return v.current
        ? `I’m using the voice ${shortVoiceName(v.current.name)}.`
        : 'I’m using the system’s default voice.'
    const names = v.list.map((x) => shortVoiceName(x.name))
    return names.length
      ? `I can use ${listOf(names.slice(0, 10))}. Say “use the voice” and a name.`
      : 'I can’t find any voices on this PC.'
  } catch {
    return 'I can’t read the list of voices right now.'
  }
}

function updateLine(s: UpdateStatus): string {
  if (s.mode === 'dev') return 'Updates are checked only in the installed app.'
  switch (s.state) {
    case 'available':
      return s.mode === 'portable'
        ? `Version ${s.version ?? 'new'} is out. Download it from the release page in Settings, About.`
        : `Version ${s.version ?? 'new'} is available; I’m getting it.`
    case 'downloading':
      return `Downloading version ${s.version ?? 'new'}. Say “restart to update” once it’s ready.`
    case 'ready':
      return `Version ${s.version ?? 'new'} is ready. Say “restart to update” to install it now, or it installs when you quit.`
    case 'up-to-date':
      return 'Lumen is up to date.'
    case 'checking':
      return 'Checking for updates now.'
    case 'error':
      return s.error ?? 'The update check didn’t work.'
    default:
      return 'Lumen is up to date as far as I know.'
  }
}

/** Runs a command; returns what to say. */
export async function runSettingsCommand(
  cmd: SettingsCommand,
  ports: SettingsPorts
): Promise<string> {
  switch (cmd.kind) {
    case 'open':
      ports.openPanel(cmd.section ? `settings/${cmd.section}` : 'settings')
      return cmd.section ? `Opening ${SECTION_LABELS[cmd.section]} settings.` : 'Opening settings.'
    case 'onboarding':
      ports.openPanel('onboarding')
      return 'Starting setup again.'
    case 'update-check': {
      if (!ports.update) return 'Updates are not available right now.'
      return updateLine(await ports.update.check())
    }
    case 'update-install': {
      const u = ports.update
      if (!u) return 'Updates are not available right now.'
      const s = u.status()
      if (s.state !== 'ready') return updateLine(s)
      const yes = await ports.confirm({
        risk: 'low',
        summary: `Restart Lumen now to install version ${s.version ?? 'new'}?`
      })
      if (!yes) return 'Okay, it installs when you quit Lumen.'
      return u.install().ok ? 'Restarting to update.' : 'I couldn’t start the update.'
    }
    case 'voice':
      return setVoice(cmd, ports)
    case 'voice-list':
      return listVoices(ports, 'list')
    case 'voice-query':
      return listVoices(ports, 'current')
    case 'query': {
      const row = rowById(cmd.id)
      return row ? describe(row, ports.config()) : 'I don’t know that setting.'
    }
    case 'set': {
      const row = rowById(cmd.id)
      if (!row) return 'I don’t know that setting.'
      const op = cmd.op
      if (row.kind === 'number') return setNumber(row, op, ports)
      if (row.kind === 'enum') {
        if ('on' in op) {
          const to = op.on ? row.onValue : row.offValue
          return to === undefined ? 'I can’t set that.' : setEnum(row, to, ports)
        }
        return 'to' in op ? setEnum(row, op.to, ports) : 'I can’t set that.'
      }
      const on = 'on' in op ? op.on : 'to' in op ? op.to === true : null
      return on === null ? 'I can’t set that.' : setBool(row, on, ports)
    }
  }
}
