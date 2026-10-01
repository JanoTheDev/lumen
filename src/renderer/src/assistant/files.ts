// Pure helpers of the bar's file drop (08 T21).

/** "812 B", "340 KB", "2.1 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** A drag that carries files from Explorer (not text or a link). */
export function isFileDrag(types: readonly string[] | DOMStringList | undefined): boolean {
  if (!types) return false
  return Array.from(types as ArrayLike<string>).includes('Files')
}

/** The bar shares at most this many files per drop (main caps the conversation at 5 too). */
export const MAX_DROP = 5
