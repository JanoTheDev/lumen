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
export const APP_URLS: Record<string, string> = {
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

const APP_ALIASES: Record<string, string> = {
  'x.com': 'x',
  'google maps': 'maps',
  'google calendar': 'calendar',
  'google drive': 'drive',
  'google docs': 'docs',
  'google sheets': 'sheets',
  'web whatsapp': 'whatsapp'
}

/** Canonical URL for a known web app name ("Gmail", "Google Drive"), or null. */
export function appUrl(name: string): string | null {
  const key = name.trim().toLowerCase()
  return APP_URLS[APP_ALIASES[key] ?? key] ?? null
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
