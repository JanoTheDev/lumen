// Hash routes for the panel window: #/settings/<section>, #/onboarding, #/home,
// #/gallery (dev only).

export type Route =
  | { name: 'settings'; section: string }
  | { name: 'onboarding' }
  | { name: 'home' }
  | { name: 'gallery' }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'gallery') return { name: 'gallery' }
  if (parts[0] === 'onboarding') return { name: 'onboarding' }
  if (parts[0] === 'home') return { name: 'home' }
  return {
    name: 'settings',
    section: parts[0] === 'settings' ? (parts[1] ?? 'general') : 'general'
  }
}
