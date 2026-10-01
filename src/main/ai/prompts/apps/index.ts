// Per-app writing style. Volatile (depends on the foreground app), so it goes in the user
// turn as app_style, never in the system prefix.
import { detectApp } from '../../app-context'
import { DISCORD, MESSAGING, SLACK } from './chat'
import { CODE_EDITOR, GENERAL, NOTION } from './docs'
import { GMAIL, OUTLOOK } from './email'
import { LINKEDIN, TWITTER } from './social'

const RULES: Record<string, string> = {
  gmail: GMAIL,
  outlook: OUTLOOK,
  linkedin: LINKEDIN,
  twitter: TWITTER,
  slack: SLACK,
  discord: DISCORD,
  messaging: MESSAGING,
  notion: NOTION,
  cursor_editor: CODE_EDITOR,
  general: GENERAL
}

/** Writing-style rules for the foreground app (the general rule when none matches). */
export function writingRulesFor(activeWindow: string): string {
  return RULES[detectApp(activeWindow)] ?? GENERAL
}
