// Home dictation stats data (04 T46), refreshed whenever the flyout is shown.
import { useCallback, useEffect, useState } from 'react'
import type { DictationStatsView } from '@shared/dictation-history'
import { invoke, useIpc } from '../../lib/ipc'

export function useDictationStats(): [DictationStatsView | null, () => void] {
  const [view, setView] = useState<DictationStatsView | null>(null)
  const refresh = useCallback((): void => {
    invoke('dictation:stats')
      .then((v) => v && typeof v.totalWords === 'number' && setView(v))
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  useIpc('home:shown', refresh)
  return [view, refresh]
}
