// Ledger spend for task rows, the task chat header and automation rows (05 T44).
import { useEffect, useState } from 'react'
import type { UsageCost } from '@shared/usage'
import { invoke } from '../../../lib/ipc'

/** Spend of these task ids (each with its helpers); re-read when `refresh` changes. */
export function useTaskCosts(ids: readonly string[], refresh: unknown): Record<string, UsageCost> {
  const [costs, setCosts] = useState<Record<string, UsageCost>>({})
  const key = ids.join(',')
  useEffect(() => {
    let live = true
    const list = key ? key.split(',').slice(0, 50) : []
    if (!list.length) return
    invoke('usage:tasks', { ids: list })
      .then((c) => live && c && !('error' in c) && setCosts(c))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [key, refresh])
  return costs
}

/** This month's spend per automation id; re-read when `refresh` changes. */
export function useAutomationCosts(refresh: unknown): Record<string, UsageCost> {
  const [costs, setCosts] = useState<Record<string, UsageCost>>({})
  useEffect(() => {
    let live = true
    invoke('usage:by-automation')
      .then((c) => live && c && !('error' in c) && setCosts(c))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [refresh])
  return costs
}
