// HTML → readable text without a DOM: a small Readability-style extractor (largest <article>,
// else <main>, else <body>; menus, headers, footers, forms and scripts dropped) plus the page's
// meta facts. Deliberately tiny (no jsdom / linkedom in the bundle). No Electron.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“'
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Readable text of any HTML: no scripts, styles or tags; block ends become newlines. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const MAX_ARTICLE_CHARS = 60_000

const DROP = [
  'script',
  'style',
  'noscript',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  'template',
  'button'
]

/** A `<meta property|name=key content=…>` value, entities decoded; '' when absent. */
export function metaContent(html: string, key: string): string {
  const k = key.replace(/[.:]/g, '\\$&')
  const a = new RegExp(
    `<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`,
    'i'
  ).exec(html)?.[1]
  const b = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`,
    'i'
  ).exec(html)?.[1]
  return decodeEntities(a ?? b ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The page title and its main text (article / main / body), markdown-ish. */
export function htmlToArticle(html: string): { title: string; text: string } {
  let h = html.replace(/<!--[\s\S]*?-->/g, '')
  const title = decodeEntities(
    (
      /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i.exec(h)?.[1] ??
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1] ??
      /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(h)?.[1] ??
      ''
    ).replace(/<[^>]+>/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim()
  for (const tag of DROP) h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ')
  const pick = (tag: string): string | null => {
    const all = [...h.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map(
      (m) => m[1]
    )
    return all.length ? all.sort((a, b) => b.length - a.length)[0] : null
  }
  const body = pick('article') ?? pick('main') ?? pick('body') ?? h
  const text = decodeEntities(
    body
      .replace(/<img\b[^>]*\balt=["']([^"']{3,})["'][^>]*>/gi, '\n[image: $1]\n')
      .replace(
        /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_m, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${t}\n`
      )
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<(?:kbd|code)\b[^>]*>([\s\S]*?)<\/(?:kbd|code)>/gi, '`$1`')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|section|tr|pre|blockquote|ul|ol|table|figure)>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_ARTICLE_CHARS)
  return { title, text }
}

export interface ReadablePage {
  title: string
  text: string
  /** og:site_name, else ''. */
  site: string
  /** article:published_time as given, else ''. */
  published: string
  /** rel=canonical (absolute), else ''. */
  canonical: string
}

/** htmlToArticle plus the page's site name, publish time and canonical link. */
export function readablePage(html: string, base: string): ReadablePage {
  const { title, text } = htmlToArticle(html)
  let canonical = ''
  const href =
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(html)?.[1]
  if (href) {
    try {
      const u = new URL(decodeEntities(href), base)
      if (u.protocol === 'https:') canonical = u.href
    } catch {
      /* ignored */
    }
  }
  return {
    title,
    text,
    site: metaContent(html, 'og:site_name'),
    published: metaContent(html, 'article:published_time'),
    canonical
  }
}
