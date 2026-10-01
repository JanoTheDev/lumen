// Sub-agent tools of a foreground agent task (08 T49): the task's own offered tools and
// guarded handlers, except read_file, which in the foreground reads dropped files by id: a
// reader sub-agent gets the background read_file (granted folders, plus the skill's own folders)
// and read_document instead, behind the same skill guard, feeding the task's observed text.
import type { ToolDef } from '../../ai/providers/types'
import { writeAudit } from '../../audit/log'
import { loadConfig } from '../../config'
import { GRANTED_FILE_TOOLS, grantedFileHandlers, realGrantedPorts } from '../../files/granted'
import { backgroundAuditEntry, readUnder } from '../background'
import { createBackgroundHandlers, type BgPorts } from '../background/handlers'
import { BG_TOOLS } from '../background/tools'
import type { ToolHandler } from '../runner'
import type { SkillEnvelope } from '../skill-envelope'

export interface ForegroundSubagentOpts {
  taskId: string
  userText: string
  /** The task's offered definitions and its final (guarded) handlers. */
  defs: readonly ToolDef[]
  handlers: Partial<Record<string, ToolHandler>>
  envelope?: SkillEnvelope
  /** Text a reader read (the policy's injection check). */
  observe(text: string): void
  observedText(): string
}

const unavailable = (): never => {
  throw new Error('not available to helpers')
}

export function foregroundSubagentTools(o: ForegroundSubagentOpts): {
  defs: ToolDef[]
  handlers: Record<string, ToolHandler>
} {
  const handlers: Record<string, ToolHandler> = {}
  for (const [k, h] of Object.entries(o.handlers)) if (h && k !== 'read_file') handlers[k] = h
  const defs = o.defs.filter((d) => d.name !== 'read_file')
  const offers = (name: string): boolean => !o.envelope || o.envelope.offers(name)
  const audit = (
    action: Record<string, unknown>,
    result: 'ok' | 'error' | 'denied',
    reason?: string
  ): void => {
    const e = backgroundAuditEntry(
      { id: o.taskId, origin: 'agent' },
      action,
      result,
      reason,
      new Date()
    )
    writeAudit({ ...e, task: `agent:${o.taskId}` })
  }
  const folders = (): string[] => loadConfig().agent.background.readFolders
  // Only read_file of the background handlers is used; the other ports are never reached.
  const ports: BgPorts = {
    taskId: o.taskId,
    child: true,
    fetch: unavailable,
    readFile: (path) => readUnder(path, folders(), o.envelope ? [o.envelope] : []),
    memorySearch: () => '',
    memoryWrite: () => 'disabled',
    notify: () => {},
    ask: unavailable,
    requestForeground: unavailable,
    spawn: unavailable,
    childCount: () => 0,
    progress: () => {},
    audit
  }
  const granted = realGrantedPorts(folders, audit)
  const readers: Record<string, ToolHandler> = {
    read_file: createBackgroundHandlers(ports).read_file,
    read_document: grantedFileHandlers(
      () => granted,
      () => ({
        origin: 'agent',
        taskId: o.taskId,
        userText: o.userText,
        observedText: o.observedText()
      })
    ).read_document
  }
  const readerDefs: ToolDef[] = [BG_TOOLS.read_file, GRANTED_FILE_TOOLS.read_document]
  for (const d of readerDefs) {
    if (!offers(d.name)) continue
    const h = readers[d.name]
    const guard = o.envelope?.guard
    handlers[d.name] = async (input, ctx) => {
      const refused = guard ? await guard(d.name, input, ctx.signal) : null
      if (refused) return refused
      const r = await h(input, ctx)
      if (!r.isError) {
        const t = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
        if (t.trim()) o.observe(t)
      }
      return r
    }
    defs.push(d)
  }
  return { defs, handlers }
}
