import { useState } from 'react'
import type { AssistantView } from '@shared/channels'
import { LiveRegion } from '../ui'
import { useIpc } from '../lib/ipc'
import { statusLine } from './model'
import { VoiceHost } from './VoiceHost'

export function AssistantApp(): JSX.Element {
  const [view, setView] = useState<AssistantView | null>(null)
  useIpc('assistant:state', setView)
  return (
    <>
      <VoiceHost />
      <LiveRegion />
      <div role="region" aria-label="Lumen assistant" className="as-root">
        {view?.visible && <div className="as-card surface">{statusLine(view)}</div>}
      </div>
    </>
  )
}
