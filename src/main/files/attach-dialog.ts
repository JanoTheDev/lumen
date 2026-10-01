// attach_file (agent mode): puts a shared file (dropped on the bar, pointed at in Explorer, or
// made with create_file) into the open file dialog of Gmail or Outlook. The model passes only
// the file's id; the path comes from the shared-file list, so a model-made-up path can never
// be attached. The dialog must be in front and belong to a browser or Outlook; the File name
// box is filled through UI Automation and Open is pressed (Enter as the fallback), both
// through the executor (policy gate, audit, input lane).
import type { Action, ElementNode } from '@shared/types'
import type { ToolContent } from '../ai/providers/types'
import { flattenElements } from '../query/uia-list'
import type { CheckResult, SharedFile } from './store'

/** Apps whose file dialogs attach mail: browsers (Gmail, Outlook on the web) and Outlook. */
export const ATTACH_PROCESSES = new Set([
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
  'brave.exe',
  'olk.exe',
  'outlook.exe'
])

export interface DialogFields {
  nameField: ElementNode
  okButton: ElementNode | null
}

/** The File name box (id 1148) and the Open button (id 1) of a Windows file dialog. Pure. */
export function dialogFields(root: ElementNode): DialogFields | null {
  const all = flattenElements(root).map((e) => e.node)
  const fields = all.filter(
    (n) =>
      (n.role === 'edit' || n.role === 'combobox') &&
      (n.automationId === '1148' || /^file\s*name:?$/i.test(n.name.trim()))
  )
  // The combo box holds the edit that takes the value.
  const nameField =
    fields.find((n) => n.role === 'edit' && n.patterns.includes('value')) ??
    fields.find((n) => n.patterns.includes('value'))
  if (!nameField) return null
  const okButton =
    all.find((n) => (n.role === 'button' || n.role === 'splitbutton') && n.automationId === '1') ??
    all.find(
      (n) =>
        (n.role === 'button' || n.role === 'splitbutton') &&
        /^(open|insert|attach|upload|choose)$/i.test(n.name.trim())
    ) ??
    null
  return { nameField, okButton }
}

export interface AttachPorts {
  file(id: string): SharedFile | undefined
  check(path: string): Promise<CheckResult>
  foreground(): Promise<{ title: string; process: string; className?: string }>
  snapshot(): Promise<ElementNode>
  /** Runs actions through the executor (origin agent, the task's input lane). */
  run(
    actions: Action[]
  ): Promise<{ executed: number; blocked: boolean; denied?: { reason: string } }>
  /** Waits until the dialog is gone; false when it is still open. */
  closed(title: string): Promise<boolean>
}

export interface AttachOutcome {
  content: ToolContent[]
  isError?: boolean
}

const text = (t: string, isError = false): AttachOutcome => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError } : {})
})

export async function attachFile(fileId: string, p: AttachPorts): Promise<AttachOutcome> {
  const f = p.file(fileId)
  if (!f) return text('E_DENIED: no shared file with that id (use one from the files list).', true)
  const checked = await p.check(f.path)
  if (!checked.ok) return text(`The file can no longer be attached: ${checked.error}`, true)
  const w = await p.foreground()
  if (!ATTACH_PROCESSES.has(w.process.toLowerCase()))
    return text(
      'E_DENIED: attach_file works only in a file dialog of a browser or Outlook. Click the attach button first so the dialog opens.',
      true
    )
  const fields = dialogFields(await p.snapshot())
  if (!fields)
    return text(
      'No file dialog is open. Click the attach (paperclip) button, wait for the dialog, then call attach_file again.',
      true
    )
  const actions: Action[] = [
    {
      type: 'uia_act',
      elementId: fields.nameField.id,
      action: 'set_value',
      value: checked.path,
      description: 'File name'
    },
    fields.okButton
      ? {
          type: 'uia_act',
          elementId: fields.okButton.id,
          action: 'invoke',
          description: fields.okButton.name || 'Open'
        }
      : { type: 'hotkey', keys: ['enter'] }
  ]
  const r = await p.run(actions)
  if (r.denied) return text(`E_DENIED: ${r.denied.reason}. Do not retry this.`, true)
  if (r.blocked || r.executed < actions.length) return text('The file was not attached.', true)
  const gone = await p.closed(w.title)
  return gone
    ? text(`Attached ${checked.name}. Check that it shows in the message.`)
    : text('The dialog is still open: it may show an error. Observe the screen.', true)
}
