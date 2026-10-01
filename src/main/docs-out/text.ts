// Text formats: Markdown, plain text, CSV and HTML (also the source of the PDF). Pure.
import { plain, runs, tablesOf, type DocContent } from './schema'

// ---- Markdown ----

const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

function mdTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]): string[] => [...r, ...Array(width - r.length).fill('')]
  const line = (r: string[]): string => `| ${pad(r).map(mdCell).join(' | ')} |`
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')
}

export function toMarkdown(doc: DocContent): string {
  const parts: string[] = []
  if (doc.title) parts.push(`# ${doc.title}`)
  const shift = doc.title ? 1 : 0
  for (const b of doc.blocks) {
    if (b.kind === 'heading') parts.push(`${'#'.repeat(Math.min(6, b.level + shift))} ${b.text}`)
    else if (b.kind === 'paragraph') parts.push(b.text)
    else if (b.kind === 'bullets') parts.push(b.items.map((i) => `- ${i}`).join('\n'))
    else if (b.kind === 'numbered') parts.push(b.items.map((i, n) => `${n + 1}. ${i}`).join('\n'))
    else if (b.rows.length) parts.push(mdTable(b.rows))
  }
  return parts.join('\n\n') + '\n'
}

// ---- Plain text ----

function textTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length))
  const cells = rows.map((r) => Array.from({ length: width }, (_, i) => plain(r[i] ?? '')))
  const w = Array.from({ length: width }, (_, i) =>
    Math.min(40, Math.max(...cells.map((r) => r[i].length)))
  )
  const line = (r: string[]): string =>
    r
      .map((c, i) => c.padEnd(w[i]))
      .join('  ')
      .trimEnd()
  const rule = w.map((n) => '-'.repeat(n)).join('  ')
  return [line(cells[0]), rule, ...cells.slice(1).map(line)].join('\r\n')
}

export function toText(doc: DocContent): string {
  const parts: string[] = []
  if (doc.title) parts.push(`${doc.title}\r\n${'='.repeat(Math.min(80, doc.title.length))}`)
  for (const b of doc.blocks) {
    if (b.kind === 'heading')
      parts.push(b.level === 1 ? `${plain(b.text)}\r\n${'-'.repeat(b.text.length)}` : plain(b.text))
    else if (b.kind === 'paragraph') parts.push(plain(b.text))
    else if (b.kind === 'bullets') parts.push(b.items.map((i) => `- ${plain(i)}`).join('\r\n'))
    else if (b.kind === 'numbered')
      parts.push(b.items.map((i, n) => `${n + 1}. ${plain(i)}`).join('\r\n'))
    else if (b.rows.length) parts.push(textTable(b.rows))
  }
  return parts.join('\r\n\r\n') + '\r\n'
}

// ---- CSV ----

/**
 * A cell as Excel would not run it: text starting with = + @ (or - not followed by a number),
 * tab or CR gets a leading apostrophe, so a formula from a shared document stays text.
 */
export function csvSafe(cell: string): string {
  return /^[=+@\t\r]/.test(cell) || /^-(?![\d.])/.test(cell) ? `'${cell}` : cell
}

export function csvField(cell: string, safe = true): string {
  const c = safe ? csvSafe(cell) : cell
  return /[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c
}

/** `safe`: formula-looking cells become text (files Lumen writes); false for reading. */
export function rowsToCsv(rows: string[][], safe = true): string {
  return rows.map((r) => r.map((c) => csvField(c, safe)).join(',')).join('\r\n') + '\r\n'
}

/** The first table; a document without one becomes one line per paragraph / item. */
export function toCsv(doc: DocContent): string {
  const table = tablesOf(doc)[0]
  if (table) return '\ufeff' + rowsToCsv(table.rows.map((r) => r.map(plain)))
  const lines: string[][] = []
  for (const b of doc.blocks) {
    if (b.kind === 'heading' || b.kind === 'paragraph') lines.push([plain(b.text)])
    else for (const i of b.items) lines.push([plain(i)])
  }
  return '\ufeff' + rowsToCsv(lines)
}

/** RFC 4180 parse (quotes, doubled quotes, CRLF / LF); `sep` "," or tab. Pure. */
export function parseCsv(text: string, sep = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const s = text.replace(/^\ufeff/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** "," unless the header line has more tabs or semicolons (European Excel exports). */
export function sniffSeparator(text: string): string {
  const head = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (c: string): number => head.split(c).length - 1
  const best = [',', '\t', ';'].sort((a, b) => count(b) - count(a))[0]
  return count(best) > 0 ? best : ','
}

// ---- HTML ----

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const inline = (s: string): string =>
  runs(s)
    .map((r) => (r.bold ? `<strong>${escapeHtml(r.text)}</strong>` : escapeHtml(r.text)))
    .join('')

const STYLE = `body{font-family:"Segoe UI",Arial,sans-serif;font-size:11pt;line-height:1.45;color:#1b1b1b;max-width:46em;margin:2em auto;padding:0 1em}
h1{font-size:20pt;margin:0 0 .6em}h2{font-size:15pt;margin:1.2em 0 .4em}h3{font-size:12.5pt;margin:1em 0 .3em}h4{font-size:11.5pt}
table{border-collapse:collapse;margin:.6em 0;width:100%}th,td{border:1px solid #999;padding:4px 7px;text-align:left;vertical-align:top}th{background:#eee}
@media print{body{margin:0;max-width:none}}`

export function toHtml(doc: DocContent): string {
  const body: string[] = []
  if (doc.title) body.push(`<h1>${escapeHtml(doc.title)}</h1>`)
  const shift = doc.title ? 1 : 0
  for (const b of doc.blocks) {
    if (b.kind === 'heading') {
      const h = Math.min(6, b.level + shift)
      body.push(`<h${h}>${inline(b.text)}</h${h}>`)
    } else if (b.kind === 'paragraph') body.push(`<p>${inline(b.text)}</p>`)
    else if (b.kind === 'bullets' || b.kind === 'numbered') {
      const tag = b.kind === 'bullets' ? 'ul' : 'ol'
      body.push(`<${tag}>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}>`)
    } else if (b.rows.length) {
      const [head, ...rest] = b.rows
      body.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      )
    }
  }
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(doc.title || 'Document')}</title>
<style>${STYLE}</style></head>
<body>
${body.join('\n')}
</body></html>
`
}
