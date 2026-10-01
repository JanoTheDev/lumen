// Command mode wired to the app (04 T37): reads the selection, asks the fast model for the
// edit, writes it back with an undo record, and puts an Undo button on the bar. See command.ts.
import { clipboard, nativeImage } from 'electron'
import type { Action } from '@shared/types'
import { executeActions } from '../../actions/executor'
import type { AgentBridge } from '../../agent/bridge'
import { log } from '../../logger'
import { CancelledError } from '../../query/cancel'
import { recentlyActed, recordUndo, undoLast } from '../../undo'
import { setNotice, setStatus, setUndoHandler, settle, showAnswer } from '../../windows/assistant'
import {
  canWriteBack,
  editSummary,
  isReplyCommand,
  isStrongEditCommand,
  readSelection,
  rewriteSelection,
  writeBack,
  writeBackAction,
  type ClipboardIo,
  type CommandIo,
  type SavedClipboard
} from './command'
import { readFocus } from './insert'
import type { FocusTarget } from './terminal-guard'

export const NO_SELECTION = 'Select the text first, then say the edit.'
export const READ_ONLY_NOTICE = 'This text cannot be edited here, so the new version is shown'
/** The Undo button stays this long. */
const UNDO_CHIP_MS = 30_000

export const electronClipboard: ClipboardIo = {
  save(): SavedClipboard {
    const img = clipboard.readImage()
    return {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: img.isEmpty() ? null : img.toPNG()
    }
  },
  restore(s: SavedClipboard): void {
    const data: Electron.Data = {}
    if (s.text) data.text = s.text
    if (s.html) data.html = s.html
    if (s.rtf) data.rtf = s.rtf
    if (s.image) data.image = nativeImage.createFromBuffer(s.image)
    if (Object.keys(data).length) clipboard.write(data)
    else clipboard.clear()
  },
  readText: () => clipboard.readText(),
  writeText: (text) => clipboard.writeText(text),
  clear: () => clipboard.clear()
}

function commandIo(agent: AgentBridge): CommandIo {
  return {
    agent,
    clipboard: electronClipboard,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms))
  }
}

interface LastEdit {
  at: number
  process: string
  /** The undo helper recorded it ("undo that" works too). */
  recorded: boolean
  timer: ReturnType<typeof setTimeout>
}

let lastEdit: LastEdit | null = null

function clearChip(): void {
  if (!lastEdit) return
  clearTimeout(lastEdit.timer)
  lastEdit = null
  setNotice(undefined)
  settle()
}

async function undoEdit(agent: AgentBridge): Promise<void> {
  const edit = lastEdit
  clearChip()
  if (!edit) return
  if (edit.recorded && recentlyActed()) {
    const msg = await undoLast(1, {
      run: (actions) =>
        executeActions(actions, {
          origin: 'user-direct',
          userText: 'undo that',
          preview: false,
          refine: false
        })
    })
    setStatus('answer', msg, undefined, 4000)
    return
  }
  // Undo helper off: the app's own undo, only in the app that got the edit.
  const now = await readFocus(agent)
  if (edit.process && now.process && now.process !== edit.process) {
    setStatus('error', 'Go back to the edited text and press Ctrl+Z.', undefined, 5000)
    return
  }
  await agent.execute({ type: 'hotkey', keys: ['ctrl', 'z'] })
  log('step', 'dictation edit undone (ctrl+z)')
  setStatus('answer', 'Undone', undefined, 1500)
}

function showChip(agent: AgentBridge, text: string, process: string, recorded: boolean): void {
  clearChip()
  const timer = setTimeout(clearChip, UNDO_CHIP_MS)
  lastEdit = { at: Date.now(), process, recorded, timer }
  setUndoHandler(() => {
    undoEdit(agent).catch((e) => {
      log('fail', `dictation edit undo failed: ${(e as Error).message}`)
      setStatus('error', 'Could not undo. Press Ctrl+Z in the app.', undefined, 5000)
    })
  })
  setNotice({ text, action: 'undo' })
}

export interface EditOutcome {
  ok: boolean
  notice?: string
  /** The new text, when the model made one. */
  text?: string
}

/**
 * Runs `command` on the selection. Returns null when there is no selection and the
 * utterance may just be dictation (the caller types it as usual).
 */
export async function runEditCommand(
  agent: AgentBridge,
  command: string,
  target: FocusTarget,
  signal: AbortSignal
): Promise<EditOutcome | null> {
  const io = commandIo(agent)
  const sel = await readSelection(io, command, target)
  if (sel.kind === 'none') {
    if (!isStrongEditCommand(command)) return null
    setStatus('answer', NO_SELECTION, undefined, 4000)
    return { ok: false, notice: NO_SELECTION }
  }
  log('plan', `dictation command on a selection (${sel.text.length} chars, ${sel.via})`)
  setStatus('thinking', 'Editing the selection')
  const out = await rewriteSelection(sel.text, command, { signal })
  if (signal.aborted) throw new CancelledError()
  if (isReplyCommand(command)) {
    // A reply goes where the user wants it: shown with Copy, the selection left alone.
    showAnswer(out)
    return { ok: true, notice: 'reply shown', text: out }
  }
  if (!canWriteBack(target)) {
    // Read-only or unknown element: typing would fire the page's shortcuts (M1).
    log('skip', 'dictation command: focus is not editable, rewrite shown')
    showAnswer(out)
    setStatus('answer', READ_ONLY_NOTICE, undefined, 4000)
    return { ok: true, notice: READ_ONLY_NOTICE, text: out }
  }
  const action: Action =
    writeBackAction(out) === 'type'
      ? { type: 'type', text: out }
      : { type: 'hotkey', keys: ['ctrl', 'v'] }
  const commit = await recordUndo(action, { taskId: `dictation-edit-${Date.now().toString(36)}` })
  await writeBack(io, out)
  commit?.()
  log('done', `dictation command applied (${out.length} chars)`)
  showChip(agent, editSummary(sel.text, out), target.process, !!commit)
  setStatus('answer', 'Edited', undefined, 1500)
  return { ok: true, text: out }
}

/** A new dictation replaces the old Undo button. */
export function dropEditChip(): void {
  clearChip()
}
