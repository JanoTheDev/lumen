// Excel (.xlsx) writer: one sheet per table, bold frozen header row, numbers as numbers and
// everything else as inline strings (never formulas, so text from a shared file cannot run).
// No library (exceljs is ~22 MB installed; the SheetJS build on npm is outdated). Pure.
import { plain, tablesOf, type DocContent } from './schema'
import { XML_HEAD, xmlText } from './xml'
import { writeZip } from './zip'

const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE = 'application/vnd.openxmlformats-officedocument.spreadsheetml'

export interface Sheet {
  name: string
  rows: string[][]
}

/** "A", "B", …, "Z", "AA" for a 0-based column. */
export function colName(i: number): string {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** A plain decimal number without leading zeros ("007" and "1e5" stay text). */
export function asNumber(cell: string): number | null {
  const t = cell.trim()
  if (!/^-?(0|[1-9]\d{0,14})(\.\d{1,15})?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** Excel sheet names: ≤ 31 chars, none of []:*?/\, unique (case-insensitive), not blank. */
export function sheetNames(wanted: string[]): string[] {
  const used = new Set<string>()
  return wanted.map((w, i) => {
    const base =
      w
        .replace(/[[\]:*?/\\]/g, ' ')
        .replace(/^'+|'+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 31) || `Sheet${i + 1}`
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const tail = ` (${n})`
      name = base.slice(0, 31 - tail.length) + tail
    }
    used.add(name.toLowerCase())
    return name
  })
}

function sheetXml(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length))
  const widths = Array.from({ length: width }, (_, i) =>
    Math.min(60, Math.max(8, ...rows.slice(0, 200).map((r) => (r[i] ?? '').length + 2)))
  )
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
  const data = rows
    .map((r, ri) => {
      const cells = r
        .map((c, ci) => {
          const ref = `${colName(ci)}${ri + 1}`
          const style = ri === 0 ? ' s="1"' : ''
          const n = ri === 0 ? null : asNumber(c)
          if (n !== null) return `<c r="${ref}"${style}><v>${n}</v></c>`
          if (c === '') return ''
          return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(c.slice(0, 32_767))}</t></is></c>`
        })
        .join('')
      return `<row r="${ri + 1}">${cells}</row>`
    })
    .join('')
  const dim = `A1:${colName(width - 1)}${Math.max(1, rows.length)}`
  const freeze =
    rows.length > 1
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
  return `${XML_HEAD}<worksheet xmlns="${SS}" xmlns:r="${R}"><dimension ref="${dim}"/>${freeze}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${data}</sheetData></worksheet>`
}

const STYLES = `${XML_HEAD}<styleSheet xmlns="${SS}">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

export function sheetsToXlsx(sheets: Sheet[], title = ''): Buffer {
  const list = sheets.length ? sheets : [{ name: '', rows: [] }]
  const names = sheetNames(list.map((s) => s.name))
  const types = list
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${OFFICE}.worksheet+xml"/>`
    )
    .join('\n')
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="${OFFICE}.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="${OFFICE}.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
${types}
</Types>`
  const rootRels = `${XML_HEAD}<Relationships xmlns="${PKG}">
<Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`
  const workbook = `${XML_HEAD}<workbook xmlns="${SS}" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets>${names
    .map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')}</sheets></workbook>`
  const wbRels = `${XML_HEAD}<Relationships xmlns="${PKG}">
${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${list.length + 1}" Type="${R}/styles" Target="styles.xml"/>
</Relationships>`
  const core = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlText(title)}</dc:title><dc:creator>Lumen</dc:creator></cp:coreProperties>`
  return writeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'docProps/core.xml', data: core },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) }))
  ])
}

/** Every table a sheet; a document without tables lists its text in column A. */
export function toXlsx(doc: DocContent): Buffer {
  const tables = tablesOf(doc).map((t) => ({ name: t.name, rows: t.rows.map((r) => r.map(plain)) }))
  if (tables.length) return sheetsToXlsx(tables, doc.title)
  const rows: string[][] = []
  for (const b of doc.blocks) {
    if (b.kind === 'heading' || b.kind === 'paragraph') rows.push([plain(b.text)])
    else for (const i of b.items) rows.push([plain(i)])
  }
  return sheetsToXlsx([{ name: doc.title, rows }], doc.title)
}
