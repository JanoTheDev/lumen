// Block parser for the Markdown component. Pure, so it is unit-testable.

export type MdBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string }

const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^\s*#{1,6}\s+(.*)$/
const FENCE = /^\s*```/

/** Splits Markdown into blocks. An unclosed fence (while streaming) runs to the end. */
export function parseBlocks(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) {
      flushPara()
      const code: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++])
      out.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      flushPara()
      out.push({ kind: 'h', text: h[1] })
      continue
    }
    const b = BULLET.exec(line)
    const o = b ? null : ORDERED.exec(line)
    if (b || o) {
      flushPara()
      const kind = b ? 'ul' : 'ol'
      const prev = out[out.length - 1]
      const text = (b ?? o)![1]
      if (prev && prev.kind === kind) prev.items.push(text)
      else out.push({ kind, items: [text] })
      continue
    }
    if (!line.trim()) flushPara()
    else para.push(line.trim())
  }
  flushPara()
  return out
}
