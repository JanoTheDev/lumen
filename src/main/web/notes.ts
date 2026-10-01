// "Save this to my notes" (05 T34) hands the last web answer to the notes scratchpad (04 T45)
// through this port, so web reading does not depend on the notes module. No saver = the user
// hears that notes are not available yet.

export interface WebNote {
  /** The summary or answer text (markdown allowed). */
  text: string
  /** Page or story title. */
  title?: string
  /** The source page (https). */
  url?: string
}

/** Saves one note; false or a throw = not saved. */
export type NoteSaver = (note: WebNote) => boolean | Promise<boolean>

let saver: NoteSaver | null = null

export function setNoteSaver(fn: NoteSaver | null): void {
  saver = fn
}

export function noteSaver(): NoteSaver | null {
  return saver
}
