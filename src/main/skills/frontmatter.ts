// SKILL.md frontmatter (CONTRACTS C10): a `---` fenced YAML header, then the markdown body.
// The header is parsed by a small YAML subset reader, enough for skill manifests and nothing
// more: block maps and lists by indentation, flow `[...]` / `{...}`, quoted and plain scalars,
// `|` / `>` block text, comments. Anchors, tags, multi-documents and tabs are rejected with a
// line number. Pure, no dependencies.

export class FrontmatterError extends Error {}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue }

export interface SplitSkillFile {
  data: Record<string, YamlValue>
  body: string
}

const FENCE = /^---[ \t]*$/

/** Splits a SKILL.md into its parsed header and the body (trimmed). */
export function splitFrontmatter(text: string): SplitSkillFile {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  if (!FENCE.test(lines[0] ?? '')) throw new FrontmatterError('SKILL.md must start with a --- line')
  const end = lines.findIndex((l, i) => i > 0 && FENCE.test(l))
  if (end < 0) throw new FrontmatterError('the header has no closing --- line')
  const data = parseYaml(lines.slice(1, end).join('\n'))
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new FrontmatterError('the header must be a list of "key: value" lines')
  return {
    data,
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim()
  }
}

interface Line {
  no: number
  indent: number
  text: string
}

/** Parses the YAML subset; an empty document is an empty map. */
export function parseYaml(src: string): YamlValue {
  const lines: Line[] = []
  src.split('\n').forEach((raw, i) => {
    const lead = /^[ \t]*/.exec(raw)![0]
    if (lead.includes('\t') && raw.trim()) throw err(i + 1, 'tabs are not allowed for indenting')
    const text = stripComment(raw.slice(lead.length)).trimEnd()
    lines.push({ no: i + 1, indent: lead.length, text })
  })
  const p = new BlockParser(lines)
  p.skipBlank()
  if (p.done()) return {}
  const value = p.block(p.peek()!.indent)
  p.skipBlank()
  if (!p.done()) throw err(p.peek()!.no, 'unexpected indentation')
  return value
}

const err = (line: number, msg: string): FrontmatterError =>
  new FrontmatterError(`line ${line}: ${msg}`)

/** Drops a `#` comment that is outside quotes and starts the line or follows a space. */
function stripComment(s: string): string {
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}

const KEY_RE = /^([A-Za-z_][\w-]*|"[^"]*"|'[^']*')[ \t]*:(?:[ \t]+(.*)|$)/

class BlockParser {
  private i = 0
  constructor(private readonly lines: Line[]) {}

  done(): boolean {
    return this.i >= this.lines.length
  }
  peek(): Line | undefined {
    return this.lines[this.i]
  }
  skipBlank(): void {
    while (!this.done() && !this.lines[this.i].text) this.i++
  }

  block(indent: number): YamlValue {
    const first = this.peek()!
    return first.text === '-' || first.text.startsWith('- ') ? this.list(indent) : this.map(indent)
  }

  private map(indent: number): Record<string, YamlValue> {
    const out: Record<string, YamlValue> = {}
    for (;;) {
      this.skipBlank()
      const line = this.peek()
      if (!line || line.indent < indent) return out
      if (line.indent > indent) throw err(line.no, 'unexpected indentation')
      const m = KEY_RE.exec(line.text)
      if (!m) throw err(line.no, 'expected "key: value"')
      const key = unquoteKey(m[1])
      if (Object.prototype.hasOwnProperty.call(out, key))
        throw err(line.no, `"${key}" appears twice`)
      this.i++
      out[key] = this.valueAfter(m[2]?.trim() ?? '', indent, line.no)
    }
  }

  private list(indent: number): YamlValue[] {
    const out: YamlValue[] = []
    for (;;) {
      this.skipBlank()
      const line = this.peek()
      if (!line || line.indent < indent) return out
      if (line.indent > indent) throw err(line.no, 'unexpected indentation')
      if (line.text !== '-' && !line.text.startsWith('- ')) throw err(line.no, 'expected "- item"')
      const rest = line.text.slice(1).trim()
      if (KEY_RE.test(rest) && !/^["'[{]/.test(rest))
        throw err(line.no, 'maps inside lists are not supported; use { key: value }')
      this.i++
      out.push(this.valueAfter(rest, indent, line.no))
    }
  }

  /** The value of a `key:` or `-` line: inline, a block scalar, or a nested block. */
  private valueAfter(inline: string, indent: number, no: number): YamlValue {
    if (/^[|>][+-]?$/.test(inline)) return this.blockText(inline, indent)
    if (/^[[{]/.test(inline)) return parseInline(this.flowText(inline, indent), no)
    if (inline) return parseInline(inline, no)
    this.skipBlank()
    const next = this.peek()
    // A flow collection on the following lines (as formatters write long ones).
    if (next && next.indent > indent && /^[[{]/.test(next.text)) {
      this.i++
      return parseInline(this.flowText(next.text, indent), next.no)
    }
    if (!next || next.indent <= indent) {
      // "key:" then a list at the same indent is valid YAML ("key:\n- a").
      if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- ')))
        return this.list(indent)
      return null
    }
    return this.block(next.indent)
  }

  /** A flow collection that may continue on more-indented lines, joined into one line. */
  private flowText(first: string, indent: number): string {
    let text = first
    while (depth(text) > 0 && !this.done()) {
      const line = this.lines[this.i]
      if (line.text && line.indent <= indent) break
      text += ` ${line.text}`
      this.i++
    }
    return text
  }

  private blockText(style: string, indent: number): string {
    const parts: string[] = []
    let inner = -1
    while (!this.done()) {
      const line = this.lines[this.i]
      if (line.text && line.indent <= indent) break
      if (line.text && inner < 0) inner = line.indent
      parts.push(line.text ? `${' '.repeat(Math.max(0, line.indent - inner))}${line.text}` : '')
      this.i++
    }
    while (parts.length && !parts[parts.length - 1]) parts.pop()
    const text =
      style[0] === '|'
        ? parts.join('\n')
        : parts.reduce(
            (acc, p) =>
              !p ? `${acc}\n` : acc && !acc.endsWith('\n') ? `${acc} ${p}` : `${acc}${p}`,
            ''
          )
    return style.endsWith('-') ? text : `${text}\n`
  }
}

/** Open brackets minus closed ones, outside quotes. */
function depth(s: string): number {
  let d = 0
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') d++
    else if (c === ']' || c === '}') d--
  }
  return d
}

function unquoteKey(k: string): string {
  return k.startsWith('"') || k.startsWith("'") ? k.slice(1, -1) : k
}

/** An inline value: a flow collection or a scalar. */
function parseInline(s: string, no: number): YamlValue {
  if (/^[&*!]/.test(s)) throw err(no, 'anchors, aliases and tags are not supported')
  if (s.startsWith('[') || s.startsWith('{')) {
    const r = new FlowParser(s, no)
    const v = r.value()
    r.end()
    return v
  }
  if (s.startsWith('"') || s.startsWith("'")) {
    const r = new FlowParser(s, no)
    const v = r.value()
    r.end()
    return v
  }
  return plainScalar(s)
}

function plainScalar(s: string): YamlValue {
  const t = s.trim()
  if (t === '' || t === '~' || t === 'null') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t)
  return t
}

class FlowParser {
  private i = 0
  constructor(
    private readonly s: string,
    private readonly no: number
  ) {}

  end(): void {
    this.ws()
    if (this.i < this.s.length) throw err(this.no, `unexpected "${this.s.slice(this.i)}"`)
  }

  /** A trailing comma: the closing bracket follows; consumes it. */
  private closes(bracket: string): boolean {
    this.ws()
    if (this.s[this.i] !== bracket) return false
    this.i++
    return true
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++
  }

  value(): YamlValue {
    this.ws()
    const c = this.s[this.i]
    if (c === '[') return this.seq()
    if (c === '{') return this.map()
    if (c === '"') return this.dq()
    if (c === "'") return this.sq()
    const start = this.i
    while (this.i < this.s.length && !/[,\]}]/.test(this.s[this.i])) this.i++
    const raw = this.s.slice(start, this.i)
    if (!raw.trim()) throw err(this.no, 'missing value')
    return plainScalar(raw)
  }

  private seq(): YamlValue[] {
    this.i++
    const out: YamlValue[] = []
    this.ws()
    if (this.s[this.i] === ']') {
      this.i++
      return out
    }
    for (;;) {
      out.push(this.value())
      this.ws()
      const c = this.s[this.i++]
      if (c === ']') return out
      if (c !== ',') throw err(this.no, 'expected "," or "]"')
      if (this.closes(']')) return out
    }
  }

  private map(): Record<string, YamlValue> {
    this.i++
    const out: Record<string, YamlValue> = {}
    this.ws()
    if (this.s[this.i] === '}') {
      this.i++
      return out
    }
    for (;;) {
      this.ws()
      let key: string
      const c = this.s[this.i]
      if (c === '"') key = this.dq()
      else if (c === "'") key = this.sq()
      else {
        const start = this.i
        while (this.i < this.s.length && !/[:,}]/.test(this.s[this.i])) this.i++
        key = this.s.slice(start, this.i).trim()
      }
      this.ws()
      if (!key || this.s[this.i] !== ':') throw err(this.no, 'expected "key: value" in { }')
      this.i++
      if (Object.prototype.hasOwnProperty.call(out, key))
        throw err(this.no, `"${key}" appears twice`)
      out[key] = this.value()
      this.ws()
      const d = this.s[this.i++]
      if (d === '}') return out
      if (d !== ',') throw err(this.no, 'expected "," or "}"')
      if (this.closes('}')) return out
    }
  }

  private dq(): string {
    const start = this.i
    this.i++
    while (this.i < this.s.length && this.s[this.i] !== '"') {
      if (this.s[this.i] === '\\') this.i++
      this.i++
    }
    if (this.i >= this.s.length) throw err(this.no, 'unclosed "')
    this.i++
    try {
      return JSON.parse(this.s.slice(start, this.i)) as string
    } catch {
      throw err(this.no, 'bad escape in "..."')
    }
  }

  private sq(): string {
    let out = ''
    this.i++
    for (;;) {
      if (this.i >= this.s.length) throw err(this.no, "unclosed '")
      const c = this.s[this.i++]
      if (c === "'") {
        if (this.s[this.i] === "'") {
          out += "'"
          this.i++
        } else return out
      } else out += c
    }
  }
}
