// Settings the bar reads itself (main sends only the AssistantView): simple mode, private
// memory mode, the a11y shortcut hints shown in focused mode, the reply style and the memory
// review count.
import { useEffect, useState } from 'react'
import type { ConfigV2 } from '@shared/config'
import { invoke, useIpc } from '../lib/ipc'

export interface BarSettings {
  simple: boolean
  privateMode: boolean
  memory: boolean
  keys: { repeat?: string; pin?: string; close?: string }
  /** Reply style in use ("brief", level "ultra"), shown as a small chip. */
  style: { name: string; level?: string } | null
}

const DEFAULTS: BarSettings = {
  simple: false,
  privateMode: false,
  memory: false,
  keys: {},
  style: null
}

export function barSettings(cfg: unknown): BarSettings {
  const c = cfg as Partial<ConfigV2> | null
  if (!c || typeof c !== 'object') return DEFAULTS
  const keys = c.a11y?.shortcuts
  return {
    simple: !!c.a11y?.simpleMode,
    privateMode: !!c.memory?.enabled && !!c.memory.privateMode,
    memory: !!c.memory?.enabled,
    keys: {
      repeat: keys?.repeat || undefined,
      pin: keys?.pin || undefined,
      close: keys?.close || undefined
    },
    style: c.ai?.style ?? null
  }
}

export function useBarSettings(): BarSettings {
  const [s, setS] = useState<BarSettings>(DEFAULTS)
  useEffect(() => {
    let alive = true
    invoke('settings:get')
      .then((c) => {
        if (alive) setS(barSettings(c))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  useIpc('settings:changed', (c) => setS(barSettings(c)))
  return s
}

/** Memory facts waiting for a yes/no (05 review queue); 0 while memory is off. */
export function useMemoryPending(enabled: boolean): number {
  const [pending, setPending] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    invoke('memory:get')
      .then((m) => {
        if (alive) setPending(m.pending.length)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [enabled])
  useIpc('memory:changed', (m) => {
    if (enabled) setPending(m.pending)
  })
  return enabled ? pending : 0
}
