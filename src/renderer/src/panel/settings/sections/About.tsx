import { useEffect, useState } from 'react'
import type { AgentImplInfo, AppBuildInfo, UpdateStatus } from '@shared/channels'
import { Button, Card, Switch, icons } from '../../../ui'
import type { SectionProps } from '../meta'
import { agentLine } from './agent-line'
import { NOTICES, licenceUrl } from './AboutNotices'
import { updateLine } from './update-line'

const REPO = 'https://github.com/JanoTheDev/lumen'

const BUSY = new Set(['checking', 'downloading'])

export function About({ cfg, patch }: SectionProps): JSX.Element {
  const open = (url: string): void => window.lumen.send('assistant:open-link', url)
  const [agent, setAgent] = useState<AgentImplInfo | null>(null)
  const [build, setBuild] = useState<AppBuildInfo | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
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
  const busy = !!update && BUSY.has(update.state)
  useEffect(() => {
    const read = (): void => {
      window.lumen
        .invoke('update:status')
        .then(setUpdate)
        .catch(() => {})
    }
    read()
    if (!busy) return
    const t = setInterval(read, 1000)
    return () => clearInterval(t)
  }, [busy])
  // Portable, or automatic updates off: the new version is a link to its release page.
  const linkUrl =
    update?.state === 'available' && (update.mode === 'portable' || !cfg.system.autoUpdate)
      ? update.url
      : undefined
  const checkNow = (): void => {
    setUpdate((u) => (u ? { ...u, state: 'checking' } : u))
    window.lumen
      .invoke('update:check')
      .then(setUpdate)
      .catch(() => {})
  }
  const exportDiag = async (): Promise<void> => {
    const r = await window.lumen.invoke('diag:export').catch(() => null)
    if (r?.ok && r.path) setDiag(`Saved to ${r.path}`)
    else if (r?.error) setDiag(r.error)
  }
  return (
    <>
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
        {update && update.mode !== 'dev' && (
          <Switch
            checked={cfg.system.autoUpdate}
            onChange={(autoUpdate) => patch({ system: { autoUpdate } })}
            label="Check for updates automatically"
            hint={
              update.mode === 'portable'
                ? 'Once a day. The portable version shows a link to the new version.'
                : 'Once a day. Updates download in the background and install when you quit Lumen.'
            }
          />
        )}
        <p className="ui-hint" role="status">
          {updateLine(update, cfg.system.autoUpdate)}
        </p>
        {update && update.mode !== 'dev' && (
          <div className="panel-row">
            <Button icon={icons.download} onClick={checkNow} disabled={busy}>
              Check for updates
            </Button>
            {update.state === 'ready' && (
              <Button
                icon={icons.repeat}
                onClick={() => void window.lumen.invoke('update:install')}
              >
                Restart to update
              </Button>
            )}
            {linkUrl && (
              <Button icon={icons.external} onClick={() => open(linkUrl)}>
                Get version {update.version}
              </Button>
            )}
          </div>
        )}
        <div className="panel-row">
          <Button
            icon={icons.sparkles}
            onClick={() => window.lumen.send('panel:open', 'onboarding')}
          >
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
      <Licences open={open} />
    </>
  )
}

function Licences({ open }: { open: (url: string) => void }): JSX.Element {
  return (
    <Card
      title="Third-party licences"
      description="Lumen is free software (GNU AGPL v3) built on these parts. The full list is in resources\third_party\NOTICES.txt in the Lumen folder."
    >
      <ul className="panel-list">
        {NOTICES.map((n) => {
          const lic = licenceUrl(n.licence)
          return (
            <li key={n.name} className="panel-list__item">
              <div className="panel-list__text">
                <span className="panel-list__title">
                  {n.name} · {n.licence}
                </span>
                <span className="ui-hint">{n.use}</span>
              </div>
              <Button icon={icons.external} onClick={() => open(n.url)}>
                Source
              </Button>
              {lic && (
                <Button icon={icons.external} onClick={() => open(lic)}>
                  Licence
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
