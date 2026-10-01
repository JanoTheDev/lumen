import { useEffect, useState } from 'react'
import type { AgentImplInfo } from '@shared/channels'
import { Button, Card, icons } from '../../../ui'
import { agentLine } from './agent-line'

const REPO = 'https://github.com/JanoTheDev/lumen'

export function About(): JSX.Element {
  const open = (url: string): void => window.lumen.send('assistant:open-link', url)
  const [agent, setAgent] = useState<AgentImplInfo | null>(null)
  useEffect(() => {
    window.lumen
      .invoke('agent:info')
      .then(setAgent)
      .catch(() => {})
  }, [])
  return (
    <Card
      title="Lumen"
      description="A Windows companion that listens, points and helps you use any app. Open source."
    >
      <div className="panel-row">
        <Button icon={icons.external} onClick={() => open(REPO)}>
          Source code
        </Button>
        <Button icon={icons.external} onClick={() => open(`${REPO}/releases`)}>
          Releases
        </Button>
        <Button icon={icons.external} onClick={() => open(`${REPO}/blob/master/LICENSE`)}>
          Licence
        </Button>
      </div>
      <p className="ui-hint">{agentLine(agent)}</p>
      <div className="panel-row">
        <Button icon={icons.sparkles} onClick={() => window.lumen.send('panel:open', 'onboarding')}>
          Run setup again
        </Button>
      </div>
    </Card>
  )
}
