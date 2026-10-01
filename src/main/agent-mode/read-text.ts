// observe {what: "text"}: the readable text of the window in front (a long email, a page, a
// document) for the agent. UI Automation document text first (agent `uia_text`, capability
// `uia-text`), OCR of the active window when that is missing or too short. Redacted, capped and
// fenced as observed data. Ports keep it testable without the native agent.
import { redactForModel } from '../actions/redact'
import { observed } from './prompts'

export const OBSERVE_TEXT_MAX = 8000
/** Document text shorter than this is a toolbar or an empty pane: read the window with OCR. */
const MIN_DOC_CHARS = 80

export interface TextPorts {
  /** UIA document text of the foreground window; null without the capability or on error. */
  documentText(): Promise<{ text: string; name?: string } | null>
  /** OCR lines of the foreground window ('' when unavailable). */
  windowOcr(): Promise<string>
  window(): Promise<{ title: string; process: string } | null>
}

export interface WindowText {
  source: 'document' | 'ocr' | 'none'
  text: string
  title: string
}

export async function readWindowText(ports: TextPorts): Promise<WindowText> {
  const [win, doc] = await Promise.all([
    ports.window().catch(() => null),
    ports.documentText().catch(() => null)
  ])
  const title = win ? `${win.title}${win.process ? ` (${win.process})` : ''}` : ''
  const docText = doc?.text?.trim() ?? ''
  if (docText.length >= MIN_DOC_CHARS) return { source: 'document', text: docText, title }
  const ocr = (await ports.windowOcr().catch(() => '')).trim()
  if (ocr) return { source: 'ocr', text: ocr, title }
  if (docText) return { source: 'document', text: docText, title }
  return { source: 'none', text: '', title }
}

/** The tool result: window line + text, redacted, capped at OBSERVE_TEXT_MAX, fenced. */
export function windowTextResult(r: WindowText): string {
  if (r.source === 'none')
    return observed(
      'window text',
      `foreground: ${redactForModel(r.title) || 'unknown'}\ntext: none readable (observe the screen instead)`
    )
  const clean = redactForModel(r.text)
  const cut = clean.length > OBSERVE_TEXT_MAX
  const body = cut ? clean.slice(0, OBSERVE_TEXT_MAX) : clean
  const lines = [
    `foreground: ${redactForModel(r.title) || 'unknown'}`,
    `source: ${r.source === 'document' ? 'document text' : 'OCR of the window (visible part only)'}`,
    `text${cut ? ` (first ${OBSERVE_TEXT_MAX} of ${clean.length} characters)` : ''}:`,
    body
  ]
  return observed('window text', lines.join('\n'))
}
