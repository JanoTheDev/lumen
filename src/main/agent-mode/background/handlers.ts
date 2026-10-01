// Tool handlers of a background task. Every effect goes through an injected port, so the
// handlers are plain logic (tests use fakes); background/index.ts wires the real ones.
// Permissions = skill grants ∩ background tool set ∩ user grants; anything else is E_DENIED,
// fed back to the model as a tool error.
import type { ToolContent } from '../../ai/providers/types'
import { observed } from '../prompts'
import type { ToolHandler, ToolOutcome } from '../runner'
import type { AskUserInput } from '../tools'
import type { FetchedPage } from './fetch'
import type { ReadResult } from './files'
import {
  MAX_CHILDREN,
  type FetchUrlInput,
  type ReadFileInput,
  type RequestForegroundInput,
  type SpawnTaskInput
} from './tools'

export const MAX_NOTIFIES = 3
const MAX_FG_STEPS = 6

export type ForegroundAnswer =
  | { status: 'done'; summary: string }
  | { status: 'failed'; summary: string }
  | { status: 'later' }
  | { status: 'cancelled' }
  | { status: 'busy' }

export interface BgPorts {
  taskId: string
  /** spawn_task is not offered to children. */
  child: boolean
  fetch(url: string, signal: AbortSignal): Promise<FetchedPage>
  readFile(path: string): ReadResult
  /** lookup_howto (05 T36): how-to steps for an app; absent = not offered by this host. */
  howto?: ToolHandler
  /** memory_search (05): past sessions and saved facts, read-only. */
  memorySearch(input: { query: string; app?: string }): string
  memoryWrite(fact: string): 'ok' | 'disabled' | 'rejected'
  notify(text: string): void
  /** Queued question; the task waits until the user answers in the Tasks list or the bar. */
  ask(question: string, choices: string[] | undefined, signal: AbortSignal): Promise<string>
  requestForeground(reason: string, steps: string[], signal: AbortSignal): Promise<ForegroundAnswer>
  /** Starts a child; with wait, resolves with its result. */
  spawn(
    input: SpawnTaskInput,
    signal: AbortSignal
  ): Promise<{ id: string; summary?: string; ok: boolean }>
  childCount(): number
  progress(line: string): void
  /** Audit line (origin background:<id>). */
  audit(action: Record<string, unknown>, result: 'ok' | 'error' | 'denied', reason?: string): void
}

const text = (t: string): ToolContent[] => [{ type: 'text', text: t }]
const fail = (t: string): ToolOutcome => ({ content: text(t), isError: true })
const isDenied = (msg: string): boolean =>
  /^E_DENIED|blocked|only https|not a string|invalid URL/i.test(msg)

async function fetchUrl(
  input: FetchUrlInput,
  p: BgPorts,
  signal: AbortSignal
): Promise<ToolOutcome> {
  let host = input.url
  try {
    host = new URL(input.url).hostname
  } catch {
    /* reported below */
  }
  p.progress(`Reading ${host}`)
  try {
    const page = await p.fetch(input.url, signal)
    p.audit({ type: 'fetch_url', url: page.url, status: page.status }, 'ok')
    if (!page.text)
      return fail(
        `${page.url} returned ${page.status} with no readable text (${page.contentType || 'unknown type'}).`
      )
    const head = `status ${page.status}${page.truncated ? ', cut to the first part' : ''}`
    return {
      content: text(`${head}\n${observed(`web ${page.url}`, page.text)}`),
      label: `read ${host}`
    }
  } catch (e) {
    if (signal.aborted) throw e
    const msg = (e as Error).message
    const denied = isDenied(msg) || (e as { code?: string }).code === 'E_DENIED'
    p.audit({ type: 'fetch_url', url: input.url }, denied ? 'denied' : 'error', msg)
    return fail(denied ? `E_DENIED: ${msg}.` : `Could not fetch: ${msg}`)
  }
}

function readFile(input: ReadFileInput, p: BgPorts): ToolOutcome {
  const r = p.readFile(input.path)
  if (!r.ok) {
    p.audit({ type: 'read_file' }, r.error.startsWith('E_DENIED') ? 'denied' : 'error', r.error)
    return fail(r.error)
  }
  p.audit({ type: 'read_file', path: r.path }, 'ok')
  p.progress(`Read ${r.path.split(/[\\/]/).pop()}`)
  return { content: text(observed(`file ${r.path}`, r.text)) }
}

async function ask(input: AskUserInput, p: BgPorts, signal: AbortSignal): Promise<ToolOutcome> {
  const answer = await p.ask(input.question, input.choices?.slice(0, 4), signal)
  return { content: text(`The user answered: "${answer}"`) }
}

async function foreground(
  input: RequestForegroundInput,
  p: BgPorts,
  signal: AbortSignal
): Promise<ToolOutcome> {
  const steps = input.steps
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_FG_STEPS)
  if (!steps.length) return fail('List the steps you will take on screen.')
  p.progress(`Asked to use the mouse: ${input.reason}`)
  const r = await p.requestForeground(input.reason, steps, signal)
  switch (r.status) {
    case 'done':
      return { content: text(`Done on screen: ${r.summary}`) }
    case 'failed':
      return fail(`The on-screen steps did not work: ${r.summary}`)
    case 'busy':
      return fail(
        'The user is busy with another task on screen. Try again later or finish without it.'
      )
    case 'later':
      return fail('The user said later and has not allowed it yet. Finish and say what is left.')
    case 'cancelled':
      return fail('E_DENIED: the user declined. Finish without the on-screen steps.')
  }
}

async function spawn(input: SpawnTaskInput, p: BgPorts, signal: AbortSignal): Promise<ToolOutcome> {
  if (p.child) return fail('E_DENIED: helper tasks cannot start helpers of their own.')
  if (p.childCount() >= MAX_CHILDREN)
    return fail(`E_DENIED: at most ${MAX_CHILDREN} helper tasks per task.`)
  if (!input.prompt.trim()) return fail('Give the helper a task.')
  const r = await p.spawn(input, signal)
  if (!input.wait) return { content: text(`Started helper task ${r.id}; it runs on its own.`) }
  return r.ok
    ? { content: text(`Helper ${r.id} finished: ${r.summary ?? ''}`) }
    : fail(`Helper ${r.id} did not finish: ${r.summary ?? 'no result'}`)
}

/** Handlers for one background task, keyed by tool name. */
export function createBackgroundHandlers(p: BgPorts): Record<string, ToolHandler> {
  let notifies = 0
  return {
    fetch_url: (i, c) => fetchUrl(i as FetchUrlInput, p, c.signal),
    read_file: async (i) => readFile(i as ReadFileInput, p),
    memory_search: async (i) => {
      const query = String(i.query ?? '')
      const app = typeof i.app === 'string' && i.app ? i.app : undefined
      return {
        content: text(observed('memory', p.memorySearch({ query, ...(app ? { app } : {}) })))
      }
    },
    lookup_howto: (i, c) =>
      p.howto ? p.howto(i, c) : Promise.resolve(fail('How-to lookups are not available here.')),
    memory_write: async (i) => {
      const fact = String(i.fact ?? '').trim()
      if (!fact) return fail('The note is empty.')
      const r = p.memoryWrite(fact)
      if (r === 'disabled') return fail('Memory is off or in private mode; nothing was kept.')
      if (r === 'rejected') return fail('That note was not kept (it looks sensitive).')
      return { content: text('Kept for this session.') }
    },
    notify: async (i) => {
      const t = String(i.text ?? '').trim()
      if (!t) return fail('The notice is empty.')
      if (notifies >= MAX_NOTIFIES)
        return fail(`At most ${MAX_NOTIFIES} notices per task; put the rest in finish.`)
      notifies++
      p.notify(t)
      p.progress(t)
      return { content: text('The user was told (or it waits in the Tasks list).') }
    },
    ask_user: (i, c) => ask(i as AskUserInput, p, c.signal),
    request_foreground: (i, c) => foreground(i as RequestForegroundInput, p, c.signal),
    spawn_task: (i, c) => spawn(i as SpawnTaskInput, p, c.signal)
  }
}
