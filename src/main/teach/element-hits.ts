// Lesson element lookup over a UIA snapshot (pure, shared by the lesson ports and the
// lesson-check eval): role / automationId must match, then exact names, else names that
// contain the wanted one. Names and roles compare case-insensitively.
import type { ElementNode } from '@shared/types'
import type { ElementMatch } from './lesson'

const norm = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

export function elementHits(nodes: ElementNode[], q: ElementMatch): ElementNode[] {
  const byRole = nodes.filter(
    (n) =>
      (!q.role || norm(n.role) === norm(q.role)) &&
      (!q.automationId || n.automationId === q.automationId)
  )
  if (!q.name) return byRole
  const exact = byRole.filter((n) => norm(n.name) === norm(q.name))
  return exact.length ? exact : byRole.filter((n) => norm(n.name).includes(norm(q.name)))
}
