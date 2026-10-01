import type { UpdateStatus } from '@shared/channels'

/** One sentence about updates for About. */
export function updateLine(s: UpdateStatus | null, autoUpdate: boolean): string {
  if (!s) return ''
  if (s.mode === 'dev') return 'Updates are off in development builds.'
  switch (s.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return `Downloading version ${s.version}${s.percent ? ` (${s.percent}%)` : ''}…`
    case 'ready':
      return `Version ${s.version} is ready. It installs when you quit Lumen.`
    case 'available':
      return s.mode === 'portable' || !autoUpdate
        ? `Version ${s.version} is available.`
        : `Version ${s.version} is available. It will download in the background.`
    case 'up-to-date':
      return 'Lumen is up to date.'
    case 'error':
      return s.error ?? 'Could not check for updates.'
    default:
      if (!autoUpdate) return 'Automatic update checks are off.'
      return s.mode === 'portable'
        ? 'Lumen looks for new versions once a day. The portable version does not install them itself.'
        : 'Lumen checks for updates once a day.'
  }
}
