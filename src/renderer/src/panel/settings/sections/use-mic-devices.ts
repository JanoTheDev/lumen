// Audio input devices, refreshed when one is plugged in or removed.
import { useCallback, useEffect, useState } from 'react'
import type { MicDevice } from './voice-options'

export function useMicDevices(): [MicDevice[], () => void] {
  const [devices, setDevices] = useState<MicDevice[]>([])
  const refresh = useCallback((): void => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) =>
        setDevices(list.map((d) => ({ deviceId: d.deviceId, label: d.label, kind: d.kind })))
      )
      .catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
    const md = navigator.mediaDevices
    md?.addEventListener('devicechange', refresh)
    return () => md?.removeEventListener('devicechange', refresh)
  }, [refresh])
  return [devices, refresh]
}
