// Hash routes for the panel window: #/settings/<section>, #/onboarding, #/home,
// #/tasks/<id> (task chat view), #/gallery (dev only).

export type Route =
  | { name: 'settings'; section: string }
  | { name: 'onboarding' }
  | { name: 'home' }
  | { name: 'tasks'; id?: string }
  | { name: 'gallery' }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'gallery') return { name: 'gallery' }
  if (parts[0] === 'onboarding') return { name: 'onboarding' }
  if (parts[0] === 'home') return { name: 'home' }
  if (parts[0] === 'tasks')
    return /^(bg|t|cc)_[a-z0-9]{4,40}$/.test(parts[1] ?? '')
      ? { name: 'tasks', id: parts[1] }
      : { name: 'tasks' }
  return {
    name: 'settings',
    section: parts[0] === 'settings' ? (parts[1] ?? 'general') : 'general'
  }
}
