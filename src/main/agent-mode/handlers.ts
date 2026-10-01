// The real tool handlers of foreground agent mode: observe (capture + UIA list), act (ghost
// cursor strategy + verification), keys, navigate, launch_app (known-app registry), wait_for,
// ask_user. Every input goes through executeActions (policy gate, audit, dwell hold) or the
// policy gate directly (launch_app).
import { spawn } from 'child_process'
import { screen, shell } from 'electron'
import type { ElementNode } from '@shared/types'
import type { ToolContent } from '../ai/providers/types'
import { executeActions, type ExecuteOptions, type ExecuteResult } from '../actions/executor'
import { gate } from '../actions/policy'
import { redactForModel } from '../actions/redact'
import type { TaskState } from '../actions/safety'
import { logicalToPhys, physToLogical } from '../actions/coords'
import { getAgent, requireAgent } from '../agent/instance'
import * as commands from '../agent/commands'
import type { AgentBridge } from '../agent/bridge'
import { captureContext } from '../query/capture'
import { currentContext } from '../query/context'
import { elementIndex, flattenElements, serializeElements } from '../query/uia-list'
import { readFocus, waitForSettle } from '../ai/observe'
import { checksFor, verify, type Check, type Observation } from '../ai/verify'
import { log } from '../logger'
import * as screenLayer from '../windows/screen-layer'
import { focusOff, focusOn } from '../focus'
import { appRegistry, findApp, launchEntry } from './apps'
import { askUser, type AskIo } from './ask'
import { performAct, type StrategyPorts, type TypedFields } from './exec-strategy'
import { withInputLane } from './input-lane'
import { observed } from './prompts'
import type { ToolHandler, ToolOutcome } from './runner'
import type {
  ActInput,
  AskUserInput,
  FocusModeInput,
  KeysInput,
  LaunchAppInput,
  NavigateInput,
  ObserveInput,
  WaitForInput
} from './tools'
import { waitFor, type WaitProbe } from './wait-for'

export interface TaskEnv {
  taskId: string
  prompt: string
  state: TaskState
  fields: TypedFields
  /** Text the agent has read this task (injection check), newest last, capped. */
  observedText: string
  ask: AskIo
}

const MAX_OBSERVED = 20_000
const SETTLE_MS = 1500
const SMALL_FRAME = 640
const UIA_TIMEOUT_MS = 2000

const text = (t: string): ToolContent[] => [{ type: 'text', text: t }]
const fail = (t: string, extra: Partial<ToolOutcome> = {}): ToolOutcome => ({
  content: text(t),
  isError: true,
  ...extra
})

function noteObserved(env: TaskEnv, t: string): void {
  env.observedText = (env.observedText + '\n' + t).slice(-MAX_OBSERVED)
}

function execOpts(env: TaskEnv, signal: AbortSignal): ExecuteOptions {
  return {
    signal,
    origin: 'agent',
    taskId: env.taskId,
    userText: env.prompt,
    task: env.state,
    observedText: env.observedText,
    preview: false,
    pauseMs: 100
  }
}

/** Real input of this task, one batch at a time through the input lane. */
function run(
  env: TaskEnv,
  actions: Parameters<typeof executeActions>[0],
  signal: AbortSignal
): Promise<ExecuteResult> {
  return withInputLane(env.taskId, () => executeActions(actions, execOpts(env, signal)), {
    signal
  })
}

function denied(r: ExecuteResult): string | null {
  return r.denied
    ? `E_DENIED: ${r.denied.reason}. Do not retry this; tell the user in finish.`
    : null
}

// ---- observe ----

async function observe(
  input: ObserveInput,
  env: TaskEnv,
  signal: AbortSignal
): Promise<ToolOutcome> {
  const agent = requireAgent()
  if (input.what === 'window') {
    const w = await commands.activeWindow(agent, { signal })
    const line = `foreground: ${w.title} (${w.process})${w.isBrowser ? ' [browser]' : ''}`
    noteObserved(env, w.title)
    return { content: text(observed('window', redactForModel(line))) }
  }
  const ctx = await captureContext(true, { signal })
  const frame = ctx.frames[0]
  const list = frame ? serializeElements(ctx.uia, frame.geometry) : null
  const lines = [
    `foreground: ${ctx.activeWindow}${ctx.foreground.process ? ` (${ctx.foreground.process})` : ''}`,
    frame ? `screenshot: ${frame.geometry.imgW}x${frame.geometry.imgH} px` : 'screenshot: none',
    ctx.marks?.length ? `marks: ${ctx.marks.length} numbered boxes on the screenshot` : '',
    list
      ? `elements (id role "name" @(x,y,w,h) in screenshot px)${list.truncated ? ', truncated' : ''}:\n${list.text}`
      : 'elements: none readable (use marks or visible text)'
  ].filter(Boolean)
  const body = redactForModel(lines.join('\n'))
  noteObserved(env, body)
  const content: ToolContent[] = [{ type: 'text', text: observed('screen', body) }]
  if (input.what === 'screen' && ctx.screenshot)
    content.push({ type: 'image', base64: ctx.screenshot, mediaType: 'image/jpeg' })
  return { content }
}

// ---- act ----

function strategyPorts(env: TaskEnv): StrategyPorts {
  return {
    element: (id) => elementIndex(currentContext()?.uia).get(id),
    readValue: async (el, signal) => {
      if (el) {
        const fresh = await commands
          .uiaSnapshot(
            requireAgent(),
            { scope: 'foreground', maxNodes: 600, interactiveOnly: true },
            { signal, timeoutMs: UIA_TIMEOUT_MS }
          )
          .catch(() => null)
        const same = fresh
          ? flattenElements(fresh.root)
              .map((f) => f.node)
              .find(
                (n) =>
                  n.role === el.role && n.name === el.name && n.automationId === el.automationId
              )
          : undefined
        if (same?.value !== undefined && same.patterns.includes('value')) return same.value
      }
      const focus = await readFocus(signal)
      return focus?.editable && focus.valueTail ? focus.valueTail : null
    },
    execute: (actions, signal) => run(env, actions, signal),
    buddy: (to, mode) => {
      try {
        screenLayer.setScene({ buddy: to ? { to, mode } : undefined })
      } catch {
        /* no screen layer (tests, headless) */
      }
    },
    physToLogical,
    pointer: () => {
      try {
        return logicalToPhys(screen.getCursorScreenPoint())
      } catch {
        return null
      }
    },
    restorePointer: async (p, signal) => {
      await run(env, [{ type: 'input', steps: [{ t: 'move', x: p.x, y: p.y }] }], signal)
    },
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), {
          once: true
        })
      })
  }
}

async function snapshotObs(signal: AbortSignal): Promise<Observation> {
  const agent = requireAgent()
  const [w, frame, focus] = await Promise.all([
    commands.activeWindow(agent, { signal }).catch(() => null),
    commands
      .capture(agent, { monitor: 'foreground', maxWidth: SMALL_FRAME }, { signal })
      .then((r) => r.frames[0]?.data)
      .catch(() => undefined),
    readFocus(signal)
  ])
  return { at: Date.now(), title: w?.title ?? '', image: frame, focus }
}

async function act(
  input: ActInput,
  env: TaskEnv,
  signal: AbortSignal,
  retry: boolean
): Promise<ToolOutcome> {
  const before = await snapshotObs(signal)
  const r = await performAct(input, strategyPorts(env), env.fields, signal)
  if (!r.ok) return fail(r.message, { actions: r.actions })
  const risk = r.exec?.maxRisk ?? 'low'
  const label = `${r.ghost ? 'via UI Automation' : 'mouse/keyboard'}${retry ? ' (retry)' : ''}`
  if (!input.expect && risk === 'low')
    return { content: text(r.message), actions: r.actions, label }
  // T11: deterministic checks first (title, focus value, frame diff), the vision verifier last.
  await waitForSettle(before, signal, SETTLE_MS).catch((e) => {
    if (signal.aborted) throw e
  })
  const after = await snapshotObs(signal)
  const checks: Check[] = checksFor(
    input.op === 'type' || input.op === 'set_value'
      ? [{ type: 'type', text: input.value ?? '' }]
      : [],
    []
  )
  const verdict = await verify(
    { description: r.message, successCriteria: input.expect, checks },
    before,
    after,
    signal
  )
  if (verdict.ok)
    return { content: text(`${r.message} Checked: ${verdict.reason}.`), actions: r.actions, label }
  return fail(
    `${r.message} But the check failed: ${verdict.reason}. Observe and try another way.`,
    {
      actions: r.actions,
      verifyFailed: true,
      label: `check failed: ${verdict.reason}`
    }
  )
}

// ---- keys / navigate ----

async function keys(input: KeysInput, env: TaskEnv, signal: AbortSignal): Promise<ToolOutcome> {
  const combo = input.combo
    .split('+')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
  if (!combo.length) return fail('combo is empty.')
  const r = await run(env, [{ type: 'hotkey', keys: combo }], signal)
  return denied(r)
    ? fail(denied(r)!)
    : { content: text(`Pressed ${combo.join('+')}.`), actions: r.executed }
}

async function navigate(
  input: NavigateInput,
  env: TaskEnv,
  signal: AbortSignal
): Promise<ToolOutcome> {
  const r = await run(env, [{ type: 'navigate_url', url: input.url }], signal)
  if (denied(r)) return fail(denied(r)!)
  const title = await requireAgent()
    .activeWindow()
    .catch(() => '')
  noteObserved(env, title)
  return {
    content: text(
      `Opened ${input.url}. ${observed('window', `foreground: ${redactForModel(title)}`)}`
    ),
    actions: r.executed
  }
}

// ---- launch_app ----

const AUMID_RE = /^[\w.-]+_[\w]+![\w.-]+$|^[\w.-]+![\w.-]+$/

/** launch_app: a known app by Start menu name, through the policy gate (also skill steps). */
export async function launchApp(
  input: LaunchAppInput,
  env: TaskEnv,
  signal: AbortSignal
): Promise<ToolOutcome> {
  const registry = await appRegistry()
  const { entry, closest } = findApp(input.app, registry)
  if (!entry)
    return fail(
      `"${input.app}" is not an installed app I know.${closest.length ? ` Closest: ${closest.join(', ')}.` : ''} Only Start menu apps can be started.`
    )
  const g = await gate(
    { type: 'launch_app', appId: entry.name },
    { origin: 'agent', taskId: env.taskId, userText: env.prompt, task: env.state }
  )
  if (!g.ok) return fail(`E_DENIED: ${g.decision.reason}.`)
  if (signal.aborted) {
    g.finish('cancelled')
    throw signal.reason
  }
  try {
    await launchEntry(entry, {
      openPath: (p) => shell.openPath(p),
      openAumid: async (id) => {
        if (!AUMID_RE.test(id)) throw new Error('not a packaged app id')
        spawn('explorer.exe', [`shell:AppsFolder\\${id}`], {
          detached: true,
          stdio: 'ignore'
        }).unref()
      }
    })
    g.finish('ok')
  } catch (e) {
    g.finish('error')
    return fail(`Could not start ${entry.name}: ${(e as Error).message}`)
  }
  log('step', `launched "${entry.name}" from the app registry`)
  return {
    content: text(`Started ${entry.name}. Use wait_for with its window title before acting in it.`),
    actions: 1
  }
}

// ---- wait_for ----

const changeListeners = new Set<() => void>()
let wiredAgent: AgentBridge | null = null

function wireChanges(): void {
  const agent = getAgent()
  if (!agent || agent === wiredAgent) return
  wiredAgent = agent
  const fire = (): void => changeListeners.forEach((cb) => cb())
  agent.onEvent('focus-changed', fire)
  agent.onEvent('uia-event', fire)
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

function matches(n: ElementNode, name: string, role?: string): boolean {
  return (!role || norm(n.role) === norm(role)) && norm(n.name).includes(norm(name))
}

export const waitProbe: WaitProbe = {
  title: async (signal) => (await commands.activeWindow(requireAgent(), { signal })).title,
  element: async (name, role, signal) => {
    const snap = await commands.uiaSnapshot(
      requireAgent(),
      { scope: 'foreground', maxNodes: 800, interactiveOnly: false },
      { signal, timeoutMs: UIA_TIMEOUT_MS }
    )
    return flattenElements(snap.root).some((f) => matches(f.node, name, role))
  },
  screenText: async (signal) => {
    const r = await commands.ocr(requireAgent(), {}, { signal })
    return r.lines.map((l) => l.text).join('\n')
  },
  onChange: (cb) => {
    wireChanges()
    changeListeners.add(cb)
    return () => changeListeners.delete(cb)
  },
  now: () => Date.now()
}

async function waitForTool(input: WaitForInput, signal: AbortSignal): Promise<ToolOutcome> {
  const r = await waitFor(input.condition, input.timeoutMs, waitProbe, signal)
  if (r.ok) return { content: text(`Appeared after ${r.ms} ms (${r.detail}).`) }
  return fail(`Not there after ${r.ms} ms: ${r.detail}. Observe to see what is on screen.`)
}

// ---- ask_user ----

async function ask(
  input: AskUserInput,
  env: TaskEnv,
  signal: AbortSignal,
  update: (p: { phase: 'asking'; question: { text: string; choices?: string[] } }) => void
): Promise<ToolOutcome> {
  const choices = input.choices?.slice(0, 4)
  update({
    phase: 'asking',
    question: { text: input.question, ...(choices?.length ? { choices } : {}) }
  })
  const answer = await askUser(input.question, env.ask, signal)
  if (answer === null) return { content: [], noAnswer: true }
  return { content: text(`The user answered: "${answer}"`) }
}

// ---- focus_mode ----

async function focusMode(input: FocusModeInput): Promise<ToolOutcome> {
  const region = input.region.trim() || undefined
  return { content: text(input.on ? await focusOn({ region }) : focusOff()) }
}

/** The handlers for one task. */
export function createHandlers(env: TaskEnv): Record<string, ToolHandler> {
  return {
    observe: (i, c) => observe(i as ObserveInput, env, c.signal),
    act: (i, c) => act(i as ActInput, env, c.signal, c.retry),
    keys: (i, c) => keys(i as KeysInput, env, c.signal),
    navigate: (i, c) => navigate(i as NavigateInput, env, c.signal),
    launch_app: (i, c) => launchApp(i as LaunchAppInput, env, c.signal),
    wait_for: (i, c) => waitForTool(i as WaitForInput, c.signal),
    ask_user: (i, c) => ask(i as AskUserInput, env, c.signal, c.update),
    focus_mode: (i) => focusMode(i as FocusModeInput),
    read_file: async () => fail('No files were shared in this conversation.')
  }
}
