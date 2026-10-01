// Home "Try" suggestions. Static until main feeds context-aware ones.

export const DEFAULT_SUGGESTIONS = [
  'What’s on my screen?',
  'Show numbers',
  'Where is the save button?',
  'Read this page to me',
  'Explain this error'
] as const

/** Roving focus in the suggestion row: arrows move and wrap, Home/End jump. */
export function moveIndex(i: number, key: string, n: number): number | null {
  if (n <= 0) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (i + 1) % n
    case 'ArrowLeft':
    case 'ArrowUp':
      return (i - 1 + n) % n
    case 'Home':
      return 0
    case 'End':
      return n - 1
    default:
      return null
  }
}
