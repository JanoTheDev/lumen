// Focused mode (keyboard access to the non-activating bar): before the bar takes focus, main
// records the window the user was in and gives focus back to it through the agent's
// focus_window when the user leaves the bar.

export interface ForegroundIo {
  /** The foreground window's hwnd, or null when unknown. */
  current: () => Promise<number | null>
  focus: (hwnd: number) => Promise<unknown>
}

/** Focusing never waits longer than this for the agent. */
export const LOOKUP_MS = 250

export class FocusReturn {
  private hwnd: number | null = null

  constructor(private io: ForegroundIo | null = null) {}

  setIo(io: ForegroundIo | null): void {
    this.io = io
  }

  /** Records the foreground window unless it is one of ours (`own`). */
  async remember(own: readonly number[]): Promise<void> {
    if (!this.io) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), LOOKUP_MS)))
    const h = await Promise.race([this.io.current().catch(() => null), timeout])
    clearTimeout(timer)
    if (h && !own.includes(h)) this.hwnd = h
  }

  /** The user moved on by themselves (clicked another window): nothing to restore. */
  forget(): void {
    this.hwnd = null
  }

  /** The remembered window, cleared. */
  take(): number | null {
    const h = this.hwnd
    this.hwnd = null
    return h
  }

  /** Brings `hwnd` to the front (errors are ignored: the window may be gone). */
  focus(hwnd: number): void {
    void this.io?.focus(hwnd).catch(() => {})
  }
}

/** A BrowserWindow's HWND as a number (8-byte handle on x64, 4 on x86). */
export function hwndOf(handle: Buffer | undefined): number | null {
  if (!handle || handle.length < 4) return null
  return handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0)
}
