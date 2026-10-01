// Hash routes for the panel window: #/settings/<section>, #/gallery (dev only).

export type Route = { name: 'settings'; section: string } | { name: 'gallery' }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'gallery') return { name: 'gallery' }
  return {
    name: 'settings',
    section: parts[0] === 'settings' ? (parts[1] ?? 'general') : 'general'
  }
}
