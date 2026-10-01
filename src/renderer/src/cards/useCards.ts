// Reads one stored card set from main and follows `cards:changed` (an image loaded).
import { useCallback, useEffect, useState } from 'react'
import type { CardActionRequest, CardActionResult, CardsView } from '@shared/cards'
import { invoke, useIpc } from '../lib/ipc'

/** The card set, null while loading or when it is gone (`missing`). */
export function useCardsView(id: string | undefined): { view: CardsView | null; missing: boolean } {
  const [got, setGot] = useState<{ id: string; view: CardsView | null } | null>(null)
  const load = useCallback((): void => {
    if (!id) return
    invoke('cards:get', id)
      .then((v) => setGot({ id, view: v && v.id === id ? v : null }))
      .catch(() => setGot({ id, view: null }))
  }, [id])
  useEffect(load, [load])
  useIpc('cards:changed', (changed) => {
    if (changed === id) load()
  })
  const current = got && got.id === id ? got : null
  return { view: current?.view ?? null, missing: !!current && !current.view }
}

export async function runCardAction(req: CardActionRequest): Promise<CardActionResult> {
  try {
    return await invoke('cards:action', req)
  } catch {
    return { ok: false, message: 'That did not work.' }
  }
}
