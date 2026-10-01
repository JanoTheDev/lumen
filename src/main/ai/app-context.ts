// Which app the user is in, and canonical URLs for app switching.
// Writing-style rules per app live in prompts/apps.

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
