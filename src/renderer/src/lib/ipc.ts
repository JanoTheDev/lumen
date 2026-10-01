// Typed access to `window.lumen` for renderer code. Listeners registered through useIpc are
// removed in the effect cleanup, so StrictMode's double mount leaves exactly one.
import { useEffect, useRef } from 'react'
import type {
  EventChannel,
  EventChannels,
  InvokeChannel,
  InvokeChannels,
  LumenApi,
  SendChannel,
  SendChannels
} from '@shared/channels'

type Api = Pick<LumenApi, 'on'>

function api(): LumenApi | undefined {
  return typeof window !== 'undefined' ? window.lumen : undefined
}

/**
 * Subscribes once and always calls the latest handler from `current()`. Returns the
 * unsubscribe function (a no-op without a bridge, e.g. in the dev gallery).
 */
export function subscribeIpc<C extends EventChannel>(
  bridge: Api | undefined,
  channel: C,
  current: () => (...args: EventChannels[C]) => void
): () => void {
  if (!bridge) return () => {}
  return bridge.on(channel, (...args) => current()(...args))
}

/** Listens to a main → renderer event for the component's lifetime. */
export function useIpc<C extends EventChannel>(
  channel: C,
  handler: (...args: EventChannels[C]) => void
): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => subscribeIpc(api(), channel, () => ref.current), [channel])
}

export function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeChannels[C]['args']
): Promise<InvokeChannels[C]['result']> {
  const bridge = api()
  if (!bridge) return Promise.reject(new Error('no ipc bridge'))
  return bridge.invoke(channel, ...args)
}

export function send<C extends SendChannel>(channel: C, ...args: SendChannels[C]): void {
  api()?.send(channel, ...args)
}
