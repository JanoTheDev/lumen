import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { toDocx } from '../../src/main/docs-out/docx'
import { normalizeDoc, runs, type DocContent } from '../../src/main/docs-out/schema'
import {
  csvSafe,
  parseCsv,
  sniffSeparator,
  toCsv,
  toHtml,
  toMarkdown,
  toText
} from '../../src/main/docs-out/text'
import { asNumber, colName, sheetNames, sheetsToXlsx, toXlsx } from '../../src/main/docs-out/xlsx'
import { readZip } from '../../src/main/packs/zip-read'
import { readXlsx } from '../../src/main/files/office'

const block = (b: Partial<DocContent['blocks'][number]>): DocContent['blocks'][number] => ({
  kind: 'paragraph',
  text: '',
  level: 0,
  items: [],
  rows: [],
  ...b
})

const DOC: DocContent = {
  title: 'Trip plan',
  blocks: [
    block({ kind: 'heading', text: 'Budget', level: 1 }),
    block({ text: 'We spend **little** & sleep <cheap>.' }),
    block({ kind: 'bullets', items: ['Tent', 'Stove'] }),
    block({ kind: 'numbered', items: ['Book train', 'Pack'] }),
    block({
      kind: 'table',
      rows: [
        ['Item', 'Cost'],
        ['Train', '120.5'],
        ['Food, drinks', '=SUM(B2)']
      ]
    })
  ]
}

describe('schema', () => {
  it('normalizes odd model output', () => {
    const d = normalizeDoc({
      title: '  T  ',
      blocks: [
        { kind: 'heading', text: 'H', level: 9 },
        { kind: 'nope', text: 'x' },
        { kind: 'table', rows: [['a', 1], 'bad', [null]] },
        null
      ]
    })
    expect(d.title).toBe('T')
    expect(d.blocks).toHaveLength(2)
    expect(d.blocks[0].level).toBe(3)
    expect(d.blocks[1].rows).toEqual([['a', '1'], ['']])
  })

  it('splits bold runs', () => {
    expect(runs('a **b** c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false }
    ])
  })
})

describe('docx', () => {
  it('is a valid package Word readers parse back', async () => {
    const buf = toDocx(DOC)
    const names = readZip(buf).map((f) => f.name)
    expect(names).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'word/document.xml',
        'word/styles.xml',
        'word/numbering.xml'
      ])
    )
    // A second reader (JSZip) agrees on the archive.
    const zip = await JSZip.loadAsync(buf)
    expect(await zip.file('word/document.xml')!.async('string')).toContain('Trip plan')
    const html = (await mammoth.convertToHtml({ buffer: buf })).value
    expect(html).toContain('<h1>Budget</h1>')
    expect(html).toContain('<strong>little</strong> &amp; sleep &lt;cheap&gt;.')
    expect(html).toContain('<ul><li>Tent</li><li>Stove</li></ul>')
    expect(html).toContain('<ol><li>Book train</li><li>Pack</li></ol>')
    expect(html).toMatch(/<table>.*Item.*Cost.*Train.*120\.5.*Food, drinks.*=SUM\(B2\).*<\/table>/s)
  })

  it('restarts each numbered list and ends after a table with a paragraph', () => {
    const buf = toDocx({
      title: '',
      blocks: [
        block({ kind: 'numbered', items: ['a'] }),
        block({ kind: 'numbered', items: ['b'] }),
        block({ kind: 'table', rows: [['x']] })
      ]
    })
    const files = new Map(readZip(buf).map((f) => [f.name, f.data.toString('utf8')]))
    expect(files.get('word/numbering.xml')).toContain('w:numId="3"')
    expect(files.get('word/document.xml')).toMatch(/<\/w:tbl><w:p\/><w:sectPr>/)
  })
})

describe('xlsx', () => {
  it('names columns and sheets like Excel', () => {
    expect([0, 25, 26, 701].map(colName)).toEqual(['A', 'Z', 'AA', 'ZZ'])
    expect(sheetNames(['Q1: sales', 'q1  sales', '', 'x'.repeat(40)])).toEqual([
      'Q1 sales',
      'q1 sales (2)',
      'Sheet3',
      'x'.repeat(31)
    ])
  })

  it('keeps leading zeros and formulas as text', () => {
    expect(asNumber('12.5')).toBe(12.5)
    expect(asNumber('-3')).toBe(-3)
    expect(asNumber('007')).toBeNull()
    expect(asNumber('1e5')).toBeNull()
  })

  it('round-trips tables through the reader', () => {
    const buf = toXlsx(DOC)
    const sheets = readXlsx(buf)
    expect(sheets).toHaveLength(1)
    expect(sheets[0].name).toBe('Budget')
    expect(sheets[0].rows).toEqual([
      ['Item', 'Cost'],
      ['Train', '120.5'],
      ['Food, drinks', '=SUM(B2)']
    ])
    const sheet = readZip(buf)
      .find((f) => f.name === 'xl/worksheets/sheet1.xml')!
      .data.toString()
    expect(sheet).not.toContain('<f>')
    expect(sheet).toContain('<c r="B2"><v>120.5</v></c>')
  })

  it('writes one sheet per table and lists text when there is none', () => {
    const buf = sheetsToXlsx([
      { name: 'A', rows: [['1']] },
      { name: 'B', rows: [['2']] }
    ])
    expect(readXlsx(buf).map((s) => s.name)).toEqual(['A', 'B'])
    const text = readXlsx(toXlsx({ title: 'Notes', blocks: [block({ text: 'hello' })] }))
    expect(text[0].rows).toEqual([['hello']])
  })
})

describe('csv', () => {
  it('quotes, guards formulas and starts with a BOM', () => {
    const csv = toCsv(DOC)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.slice(1)).toBe('Item,Cost\r\nTrain,120.5\r\n"Food, drinks",\'=SUM(B2)\r\n')
    expect(csvSafe('-5')).toBe('-5')
    expect(csvSafe('-cmd')).toBe("'-cmd")
    expect(csvSafe('@x')).toBe("'@x")
  })

  it('parses quoted fields, CRLF and separators', () => {
    expect(parseCsv('a,"b ""q"", c"\r\n1,2\n')).toEqual([
      ['a', 'b "q", c'],
      ['1', '2']
    ])
    expect(sniffSeparator('a;b;c\n1;2;3')).toBe(';')
    expect(sniffSeparator('a\tb\n')).toBe('\t')
    expect(parseCsv('x;y', ';')).toEqual([['x', 'y']])
  })
})

describe('markdown, text, html', () => {
  it('writes Markdown with escaped table cells', () => {
    const md = toMarkdown({
      title: 'T',
      blocks: [
        block({ kind: 'heading', text: 'H', level: 1 }),
        block({ kind: 'table', rows: [['a|b', 'c'], ['1']] })
      ]
    })
    expect(md).toBe('# T\n\n## H\n\n| a\\|b | c |\n| --- | --- |\n| 1 |  |\n')
  })

  it('writes plain text with aligned tables', () => {
    const txt = toText(DOC)
    expect(txt).toContain('Trip plan\r\n=========')
    expect(txt).toContain('- Tent')
    expect(txt).toContain('Item          Cost')
    expect(txt).not.toContain('**')
  })

  it('escapes HTML and allows no scripts', () => {
    const html = toHtml({
      title: '<script>x</script>',
      blocks: [block({ text: '<img onerror=1>' })]
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;img onerror=1&gt;')
    expect(html).toContain("default-src 'none'")
  })
})
