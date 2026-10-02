// Word (.docx) writer: the few WordprocessingML parts a document with headings, paragraphs,
// bullet and numbered lists and tables needs (no library: `docx` is ~9 MB installed). Each
// numbered list restarts at 1. The page is Letter or A4 (page-size.ts) with 1" margins. Pure:
// returns the file bytes.
import type { PageSize } from './page-size'
import { runs, type Block, type DocContent } from './schema'
import { XML_HEAD, xmlText } from './xml'
import { writeZip } from './zip'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE = 'application/vnd.openxmlformats-officedocument.wordprocessingml'

/** Page sizes in twentieths of a point. */
const PAGES: Record<PageSize, { w: number; h: number }> = {
  A4: { w: 11906, h: 16838 },
  Letter: { w: 12240, h: 15840 }
}
const MARGIN = 1440

const CONTENT_TYPES = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="${OFFICE}.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="${OFFICE}.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="${OFFICE}.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`

const ROOT_RELS = `${XML_HEAD}<Relationships xmlns="${PKG}">
<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`

const DOC_RELS = `${XML_HEAD}<Relationships xmlns="${PKG}">
<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>
</Relationships>`

const heading = (id: string, name: string, lvl: number, size: number): string =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${lvl === 0 ? 0 : 240}" w:after="80"/><w:outlineLvl w:val="${lvl}"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="${size}"/></w:rPr></w:style>`

const STYLES = `${XML_HEAD}<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
${heading('Heading1', 'heading 1', 0, 32)}
${heading('Heading2', 'heading 2', 1, 28)}
${heading('Heading3', 'heading 3', 2, 24)}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`

function numbering(numberedLists: number): string {
  const abstract = (id: number, fmt: string, text: string, font: string): string =>
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>${font}</w:lvl></w:abstractNum>`
  const nums = [`<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`]
  for (let i = 0; i < numberedLists; i++)
    nums.push(
      `<w:num w:numId="${i + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`
    )
  return `${XML_HEAD}<w:numbering xmlns:w="${W}">
${abstract(0, 'bullet', '\u2022', '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>')}
${abstract(1, 'decimal', '%1.', '')}
${nums.join('\n')}
</w:numbering>`
}

/** Runs of one line of text: **bold** spans, line breaks kept. */
function runsXml(text: string, bold = false): string {
  return runs(text)
    .map((r) => {
      const rPr = r.bold || bold ? '<w:rPr><w:b/></w:rPr>' : ''
      const lines = r.text.split(/\r?\n/)
      const body = lines
        .map((l, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlText(l)}</w:t>`)
        .join('')
      return `<w:r>${rPr}${body}</w:r>`
    })
    .join('')
}

const para = (text: string, style?: string, extra = '', bold = false): string =>
  `<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>` : ''}${runsXml(text, bold)}</w:p>`

function table(rows: string[][], textWidth: number): string {
  const width = Math.max(1, ...rows.map((r) => r.length))
  const col = Math.floor(textWidth / width)
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${col}"/>`.repeat(width)}</w:tblGrid>`
  const tr = rows
    .map((r, ri) => {
      const cells = Array.from({ length: width }, (_, i) => r[i] ?? '')
      const trPr = ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''
      const tcs = cells
        .map(
          (c) =>
            `<w:tc><w:tcPr><w:tcW w:w="${col}" w:type="dxa"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' : ''}</w:tcPr>${para(c, undefined, '', ri === 0)}</w:tc>`
        )
        .join('')
      return `<w:tr>${trPr}${tcs}</w:tr>`
    })
    .join('')
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>${grid}${tr}</w:tbl>`
}

function body(doc: DocContent, page: PageSize): { xml: string; numbered: number } {
  const size = PAGES[page]
  const out: string[] = []
  let numbered = 0
  if (doc.title) out.push(para(doc.title, 'Title'))
  let last: Block['kind'] | null = null
  for (const b of doc.blocks) {
    last = b.kind
    if (b.kind === 'heading') out.push(para(b.text, `Heading${b.level}`))
    else if (b.kind === 'paragraph') out.push(para(b.text))
    else if (b.kind === 'bullets' || b.kind === 'numbered') {
      const numId = b.kind === 'bullets' ? 1 : 2 + numbered++
      const numPr = `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`
      for (const item of b.items) out.push(para(item, 'ListParagraph', numPr))
    } else if (b.rows.length) out.push(table(b.rows, size.w - 2 * MARGIN))
    else last = null
  }
  // A table may not end the body.
  if (last === 'table' || !out.length) out.push('<w:p/>')
  const sect = `<w:sectPr><w:pgSz w:w="${size.w}" w:h="${size.h}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`
  return {
    xml: `${XML_HEAD}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${out.join('')}${sect}</w:body></w:document>`,
    numbered
  }
}

function core(title: string): string {
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(title)}</dc:title><dc:creator>Lumen</dc:creator></cp:coreProperties>`
}

export function toDocx(doc: DocContent, page: PageSize = 'A4'): Buffer {
  const b = body(doc, page)
  return writeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: b.xml },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: numbering(b.numbered) },
    { name: 'docProps/core.xml', data: core(doc.title) }
  ])
}
