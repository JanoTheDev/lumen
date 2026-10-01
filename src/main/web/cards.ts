// Answer cards for web reading (05 T30–T32): markdown for the bar's answer card with numbered
// citations as links (the card opens them through the safe-URL check). Pure.
import { hostOf, type PageContext } from './context'
import type { Story, StorySource } from './news'

// The card's Markdown has no escapes: drop or swap the characters it would read as markup.
const mdText = (s: string): string =>
  s.replace(/[*`]/g, '').replace(/\[/g, '(').replace(/\]/g, ')').replace(/_/g, ' ').trim()

const mdUrl = (u: string): string =>
  u.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20')

/** "[1](https://…) BBC News" style citation; '' without a URL. */
function cite(n: number, src: StorySource): string {
  return src.url ? `[${n}](${mdUrl(src.url)}) ${mdText(src.name || hostOf(src.url))}` : ''
}

/** "2 h ago" / "yesterday" / ''. */
export function ago(published: number, now: number): string {
  if (!published) return ''
  const min = Math.round((now - published) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

const NOTE: Record<PageContext['source'], string> = {
  screen: '',
  fetch: '',
  ocr: '_I could only read the part of the page that is visible on screen._'
}

export function pageCard(page: PageContext): string {
  const lines = [`**${mdText(page.title || page.site || 'This page')}**`, '', page.summary.trim()]
  if (page.keyPoints.length) lines.push('', ...page.keyPoints.map((p) => `- ${p.trim()}`))
  if (NOTE[page.source]) lines.push('', NOTE[page.source])
  if (page.url) lines.push('', `Source: ${cite(1, { name: page.site, url: page.url })}`)
  return lines.join('\n')
}

/** A page answer ("what does it say about X") with the page as citation [1]. */
export function answerCard(text: string, page: { url: string; site: string }): string {
  return page.url
    ? `${text.trim()}\n\nSource: ${cite(1, { name: page.site, url: page.url })}`
    : text.trim()
}

export interface Brief {
  story: Story
  brief: string
}

export function newsCard(briefs: Brief[], now: number, heading: string, note = ''): string {
  const lines = [`**${mdText(heading)}**`, '']
  briefs.forEach(({ story, brief }, i) => {
    const when = ago(story.published, now)
    const from = story.sources
      .slice(0, 3)
      .map((s) => mdText(s.name))
      .join(', ')
    const meta = [from, when].filter(Boolean).join(' · ')
    lines.push(`${i + 1}. **${mdText(story.title)}** ${brief.trim()}${meta ? ` _${meta}_` : ''}`)
  })
  const cites = briefs.map(({ story }, i) => cite(i + 1, story.sources[0])).filter(Boolean)
  if (cites.length) lines.push('', `Sources: ${cites.join(' · ')}`)
  if (note) lines.push('', note)
  lines.push('', '_Say "open the second one" or "tell me more about the first story"._')
  return lines.join('\n')
}

/** One story in depth: its brief plus every outlet that carried it. */
export function storyCard(story: Story, text: string): string {
  const cites = story.sources.map((s, i) => cite(i + 1, s)).filter(Boolean)
  return [
    `**${mdText(story.title)}**`,
    '',
    text.trim(),
    ...(cites.length ? ['', `Sources: ${cites.join(' · ')}`] : [])
  ].join('\n')
}
