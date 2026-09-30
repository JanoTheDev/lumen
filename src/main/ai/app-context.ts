// Which app the user is in: writing-style rules and canonical URLs for app switching.

export function detectApp(activeWindow: string): string {
  const w = activeWindow.toLowerCase()
  if (w.includes('gmail') || w.includes('mail.google')) return 'gmail'
  if (w.includes('linkedin')) return 'linkedin'
  if (w.includes('twitter') || w.includes('x.com') || w.includes('𝕏')) return 'twitter'
  if (w.includes('cursor') || w.includes('vscode') || w.includes('visual studio code'))
    return 'cursor_editor'
  if (w.includes('slack')) return 'slack'
  if (w.includes('notion')) return 'notion'
  if (w.includes('outlook')) return 'outlook'
  if (w.includes('discord')) return 'discord'
  if (w.includes('whatsapp') || w.includes('telegram')) return 'messaging'
  return 'general'
}

// Map of app IDs → canonical URL Lumen should navigate to on first action.
const APP_URLS: Record<string, string> = {
  gmail: 'https://mail.google.com/',
  linkedin: 'https://www.linkedin.com/',
  twitter: 'https://x.com/',
  x: 'https://x.com/',
  notion: 'https://www.notion.so/',
  outlook: 'https://outlook.live.com/mail/',
  discord: 'https://discord.com/app',
  slack: 'https://app.slack.com/',
  youtube: 'https://www.youtube.com/',
  drive: 'https://drive.google.com/',
  docs: 'https://docs.google.com/',
  sheets: 'https://sheets.google.com/',
  github: 'https://github.com/',
  reddit: 'https://www.reddit.com/',
  spotify: 'https://open.spotify.com/',
  maps: 'https://www.google.com/maps',
  calendar: 'https://calendar.google.com/',
  whatsapp: 'https://web.whatsapp.com/',
  telegram: 'https://web.telegram.org/'
}

// Returns { app, url } when the prompt explicitly names an app and the current active
// window does NOT match it. Used to force a navigate action on the first step.
export function detectRequestedApp(
  prompt: string,
  activeWindow: string
): { app: string; url: string } | null {
  const p = prompt.toLowerCase()
  const w = activeWindow.toLowerCase()
  const names: Array<[string, RegExp]> = [
    ['gmail', /\bgmail\b/],
    ['outlook', /\boutlook\b/],
    ['linkedin', /\blinkedin\b/],
    ['twitter', /\b(twitter|x\.com|my ?x)\b/],
    ['notion', /\bnotion\b/],
    ['discord', /\bdiscord\b/],
    ['slack', /\bslack\b/],
    ['youtube', /\byoutube\b/],
    ['github', /\bgithub\b/],
    ['reddit', /\breddit\b/],
    ['spotify', /\bspotify\b/],
    ['maps', /\b(google\s+)?maps\b/],
    ['calendar', /\b(google\s+)?calendar\b/],
    ['drive', /\b(google\s+)?drive\b/],
    ['docs', /\b(google\s+)?docs\b/],
    ['sheets', /\b(google\s+)?sheets\b/],
    ['whatsapp', /\bwhatsapp\b/],
    ['telegram', /\btelegram\b/]
  ]
  for (const [app, re] of names) {
    if (!re.test(p)) continue
    // Skip if active window already on that app (rough check).
    const urlHost =
      APP_URLS[app]
        ?.replace(/^https?:\/\//, '')
        .split('/')[0]
        .toLowerCase() ?? ''
    const bareHost = urlHost.replace(/^www\./, '')
    if (urlHost && (w.includes(bareHost) || w.includes(app))) return null
    const url = APP_URLS[app]
    if (url) return { app, url }
  }
  return null
}

export function isBrowser(activeWindow: string): boolean {
  const w = activeWindow.toLowerCase()
  return (
    w.includes('firefox') ||
    w.includes('chrome') ||
    w.includes('edge') ||
    w.includes('brave') ||
    w.includes('opera')
  )
}

const APP_WRITING_RULES: Record<string, string> = {
  gmail: `Writing context: Gmail email compose.
- Use professional email structure: greeting, body, sign-off
- Match formality to context (formal for business, casual for colleagues)
- No hashtags. Proper punctuation. Spell out words fully.
- COMPOSE WINDOW — action mode only, NEVER text_insert.
- Gmail compose layout (top to bottom): [Recipients/To row] → [Subject row] → [Body area].
- CRITICAL: click_element with text "Subject" often FAILS because the "Subject" label disappears once the field has any content, causing OCR to fall back to wrong coordinates (typically the To field). ALWAYS target the Subject row by its exact bbox from the screenshot, not by text:
  Subject row bbox = the narrow input row IMMEDIATELY BELOW the Recipients/To row, ABOVE the large body text area.
- Sequence for composing a new email:
  1. {"type":"click_bbox","bbox":{<subject row bbox from screenshot>},"description":"Subject field row, below Recipients"} → then type the subject line (one line, no newlines)
  2. {"type":"click_bbox","bbox":{<body area bbox>},"description":"email body area"} → then type the full email body
- If the user did NOT name a recipient, SKIP the To/Recipients field entirely. Do not click or type into To.
- NEVER click Send/Submit. Compose-only.
- Example: [{"type":"click_bbox","bbox":{"x":588,"y":222,"w":669,"h":45},"description":"Subject row"},{"type":"type","text":"Resignation"},{"type":"click_bbox","bbox":{"x":588,"y":273,"w":1206,"h":456},"description":"body area"},{"type":"type","text":"Dear...\\n\\nBody text."}]`,

  linkedin: `Writing context: LinkedIn post or message.
- Professional but personable and engaging tone
- Posts: hook first line, structured body, end with insight or question
- Messages: warm, direct, no spam vibes
- No slang. Emojis sparingly if casual. Hashtags only in posts, 2-3 max.`,

  twitter: `Writing context: X (Twitter) post or reply.
- Punchy, direct, confident
- Hard limit: 280 characters for posts
- Threads: each tweet standalone, number them if needed
- Casual register OK. Hooks matter. No corporate speak.`,

  cursor_editor: `Writing context: Cursor or VS Code (code editor).
- For code comments: concise, explain WHY not WHAT
- For commit messages: imperative mood, under 72 chars
- For PR descriptions: what changed, why, how to test
- Technical precision over politeness.`,

  slack: `Writing context: Slack message.
- Conversational and brief
- Use formatting sparingly (bold for key terms)
- No email-style greetings or sign-offs
- Get to the point fast.`,

  notion: `Writing context: Notion document.
- Clear headings and structure
- Bullet points over walls of text
- Use **bold** for key terms, keep prose scannable`,

  outlook: `Writing context: Outlook email.
- Professional email structure
- More formal register than Gmail default
- Clear subject-appropriate length`,

  discord: `Writing context: Discord.
- Casual, community tone
- Brief unless in a technical channel
- Markdown formatting supported`,

  messaging: `Writing context: WhatsApp or Telegram.
- Conversational, natural, brief
- Write like a real person texting
- Contractions and casual language are fine`,

  general: `Write naturally and clearly for the detected context.`
}

export function writingRulesFor(activeWindow: string): string {
  return APP_WRITING_RULES[detectApp(activeWindow)] || APP_WRITING_RULES.general
}
