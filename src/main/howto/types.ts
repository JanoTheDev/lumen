// How-to lookup (05 T36): shared types. No Electron.

/** One step of a how-to, with the UI names it mentions (they become grounding targets). */
export interface HowtoStep {
  text: string
  /** Menu items, buttons, tabs, fields named in the step, in order ("Format", "Font…"). */
  ui: string[]
  /** Keyboard shortcut the step names ("Ctrl+Shift+N"). */
  shortcut?: string
}

export interface HowtoSource {
  title: string
  url: string
}

/** Where an answer came from, cheapest first. */
export type HowtoOrigin = 'notes' | 'cache' | 'docs' | 'web-search' | 'none'

export interface HowtoResult {
  app: string
  version: string
  goal: string
  steps: HowtoStep[]
  sources: HowtoSource[]
  from: HowtoOrigin
  /** Paid searches run for this answer (0 for free sources). */
  searches: number
  /** Money spent on this answer (searches + tokens), USD. */
  costUsd: number
  /** Why nothing was found (from 'none'). */
  note?: string
}

export interface AppIdentity {
  /** Display name ("Notepad", "Blender"). */
  app: string
  /** Stable id for files ("notepad"). */
  appId: string
  /** File / product version ("11.2402.22.0"), '' when unknown. */
  version: string
  /** A web browser (or a site in one): tab names are page titles, not UI labels. */
  browser?: boolean
}

/** 'auto': free sources, then paid provider search when the user allowed it; caps apply. */
export type HowtoMode = 'auto' | 'free-only' | 'off'
