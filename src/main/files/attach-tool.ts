// The attach_file tool of foreground agent mode, wired to the agent and the executor.
import { z } from 'zod'
import type { ToolDef } from '../ai/providers/types'
import type { TaskState } from '../actions/safety'
import type { ToolHandler } from '../agent-mode/runner'
import { attachFile, type AttachPorts } from './attach-dialog'
import { checkDroppedPath, getFile } from './store'

export const attachFileInput = z.object({
  fileId: z
    .string()
    .describe('Id of a shared file: dropped on the bar, pointed at, or made with create_file.')
})

export const ATTACH_FILE_TOOL: ToolDef = {
  name: 'attach_file',
  description:
    'Attaches a shared file to an email: first click the attach (paperclip) button in Gmail or Outlook so the file dialog opens, then call this with the file id. It fills the dialog with the file and presses Open. Paths are not accepted.',
  schema: attachFileInput
}

export interface AttachEnv {
  taskId: string
  prompt: string
  state: TaskState
  observedText: string
}

const CLOSE_WAIT_MS = 4000
const POLL_MS = 250

function realPorts(env: AttachEnv, signal: AbortSignal): AttachPorts {
  const agent = async (): Promise<import('../agent/bridge').AgentBridge> =>
    (await import('../agent/instance')).requireAgent()
  return {
    file: getFile,
    check: checkDroppedPath,
    foreground: async () => {
      const { activeWindow } = await import('../agent/commands')
      const w = await activeWindow(await agent(), { signal })
      return {
        title: w.title,
        process: w.process,
        ...(w.className ? { className: w.className } : {})
      }
    },
    snapshot: async () => {
      const { uiaSnapshot } = await import('../agent/commands')
      return (await uiaSnapshot(await agent(), { scope: 'foreground', maxNodes: 400 }, { signal }))
        .root
    },
    run: async (actions) => {
      const { executeActions } = await import('../actions/executor')
      const { withInputLane } = await import('../agent-mode/input-lane')
      return withInputLane(
        env.taskId,
        () =>
          executeActions(actions, {
            signal,
            origin: 'agent',
            taskId: env.taskId,
            userText: env.prompt,
            task: env.state,
            observedText: env.observedText,
            preview: false,
            pauseMs: 150
          }),
        { signal }
      )
    },
    closed: async (title) => {
      const { activeWindow } = await import('../agent/commands')
      const bridge = await agent()
      for (let waited = 0; waited < CLOSE_WAIT_MS; waited += POLL_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS))
        const w = await activeWindow(bridge, { signal }).catch(() => null)
        if (w && w.title !== title) return true
      }
      return false
    }
  }
}

/** attach_file for one foreground task (`env` is read at call time). */
export function attachFileHandler(env: AttachEnv): ToolHandler {
  return async (raw, ctx) => {
    const parsed = attachFileInput.safeParse(raw)
    if (!parsed.success)
      return {
        content: [{ type: 'text', text: 'E_INVALID: attach_file needs fileId.' }],
        isError: true
      }
    return attachFile(parsed.data.fileId, realPorts(env, ctx.signal))
  }
}
