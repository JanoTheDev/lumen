// Splits the CLI's stdout into JSON objects. Chunks can end mid-line; non-JSON lines (a warning
// printed by a wrapper script) are reported, never thrown.
const MAX_LINE = 8 * 1024 * 1024

export class NdjsonParser {
  private buf = ''

  constructor(
    private readonly onObject: (value: Record<string, unknown>) => void,
    private readonly onJunk: (line: string) => void = () => {}
  ) {}

  push(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      this.line(line)
    }
    // A runaway line without a newline: drop it instead of growing forever.
    if (this.buf.length > MAX_LINE) {
      this.onJunk(this.buf.slice(0, 200))
      this.buf = ''
    }
  }

  /** The rest after the stream ended. */
  end(): void {
    const rest = this.buf
    this.buf = ''
    this.line(rest)
  }

  private line(raw: string): void {
    const line = raw.trim()
    if (!line) return
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      this.onJunk(line.slice(0, 200))
      return
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) this.onObject(v as Record<string, unknown>)
    else this.onJunk(line.slice(0, 200))
  }
}
