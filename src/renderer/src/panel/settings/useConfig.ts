import { useCallback, useEffect, useState } from 'react'
import type { ConfigPatch, ConfigV2 } from '@shared/config'
import { announce } from '../../ui/announce'

export type Config = ConfigV2
export type Patch = (update: ConfigPatch) => Promise<boolean>

function isConfig(v: unknown): v is Config {
  return !!v && typeof v === 'object' && (v as { version?: unknown }).version === 2
}

/** Loads the config, follows settings:changed, and saves patches with a polite "Saved". */
export function useConfig(): { cfg: Config | null; patch: Patch; error: string | null } {
  const [cfg, setCfg] = useState<Config | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.lumen
      .invoke('settings:get')
      .then((c) => {
        if (alive && isConfig(c)) setCfg(c)
      })
      .catch(() => setError('Couldn’t load settings.'))
    const off = window.lumen.on('settings:changed', (c) => {
      if (isConfig(c)) setCfg(c)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const patch = useCallback<Patch>(async (update) => {
    try {
      const next = await window.lumen.invoke('settings:patch', update)
      if (!isConfig(next)) {
        setError('That value wasn’t accepted.')
        announce('That value wasn’t accepted.', 'assertive')
        return false
      }
      setCfg(next)
      setError(null)
      announce('Saved')
      return true
    } catch {
      setError('Couldn’t save. Try again.')
      announce('Couldn’t save. Try again.', 'assertive')
      return false
    }
  }, [])

  return { cfg, patch, error }
}
