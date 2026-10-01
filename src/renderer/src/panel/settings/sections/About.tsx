import { useEffect, useState } from 'react'
import type { AgentImplInfo, AppBuildInfo } from '@shared/channels'
import { Button, Card, icons } from '../../../ui'
import { agentLine } from './agent-line'

const REPO = 'https://github.com/JanoTheDev/lumen'

export function About(): JSX.Element {
  const open = (url: string): void => window.lumen.send('assistant:open-link', url)
  const [agent, setAgent] = useState<AgentImplInfo | null>(null)
  const [build, setBuild] = useState<AppBuildInfo | null>(null)
  const [diag, setDiag] = useState('')
  useEffect(() => {
    window.lumen
      .invoke('agent:info')
      .then(setAgent)
      .catch(() => {})
    window.lumen
      .invoke('diag:info')
      .then(setBuild)
      .catch(() => {})
  }, [])
  const exportDiag = async (): Promise<void> => {
    const r = await window.lumen.invoke('diag:export').catch(() => null)
    if (r?.ok && r.path) setDiag(`Saved to ${r.path}`)
    else if (r?.error) setDiag(r.error)
  }
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
      {build && (
        <p className="ui-hint">
          Version {build.version}
          {build.portable ? ' (portable)' : ''}
        </p>
      )}
      <p className="ui-hint">{agentLine(agent)}</p>
      <div className="panel-row">
        <Button icon={icons.sparkles} onClick={() => window.lumen.send('panel:open', 'onboarding')}>
          Run setup again
        </Button>
      </div>
      <div className="panel-row">
        <Button icon={icons.external} onClick={() => void window.lumen.invoke('diag:open-logs')}>
          Open logs folder
        </Button>
        <Button icon={icons.external} onClick={() => void exportDiag()}>
          Export diagnostics…
        </Button>
      </div>
      {diag && (
        <p className="ui-hint" role="status">
          {diag}
        </p>
      )}
    </Card>
  )
}
