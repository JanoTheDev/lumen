// App helpers (07 T23–T26): optional bridges that let lessons check Blender and OBS exactly.
// Lumen never installs anything into another app; this page shows the steps, hands over the
// Blender add-on file and keeps the OBS WebSocket password.
import { useCallback, useEffect, useState } from 'react'
import type { BridgeId, BridgeStatus } from '@shared/channels'
import { Button, Card, Field, announce, icons } from '../../../ui'
import { invoke } from '../../../lib/ipc'

const STATE_TEXT: Record<BridgeStatus['state'], string> = {
  connected: 'Connected',
  absent: 'Not connected',
  'needs-setup': 'Needs the password',
  error: 'Not accepted'
}

function StatusLine({ s }: { s: BridgeStatus | undefined }): JSX.Element {
  if (!s) return <p className="ui-hint">Checking…</p>
  const ok = s.state === 'connected'
  return (
    <div className={ok ? 'panel-note is-ok' : 'panel-note'} role="status">
      {ok ? <icons.checkCircle /> : <icons.info />}
      <span>
        {s.name} helper: {STATE_TEXT[s.state]}
        {ok && s.version ? ` (version ${s.version})` : ''}.{!ok && s.detail ? ` ${s.detail}` : ''}
      </span>
    </div>
  )
}

export function Bridges(): JSX.Element {
  const [status, setStatus] = useState<Partial<Record<BridgeId, BridgeStatus>>>({})
  const [busy, setBusy] = useState<BridgeId | null>(null)
  const [addonMsg, setAddonMsg] = useState('')
  const [password, setPassword] = useState('')
  const [port, setPort] = useState('')
  const [obsMsg, setObsMsg] = useState('')

  const refresh = useCallback(() => {
    invoke('bridges:status')
      .then((list) => setStatus(Object.fromEntries(list.map((s) => [s.id, s]))))
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])

  const test = async (id: BridgeId): Promise<void> => {
    setBusy(id)
    try {
      const s = await invoke('bridges:test', id)
      setStatus((prev) => ({ ...prev, [id]: s }))
      announce(`${s.name} helper: ${STATE_TEXT[s.state]}`, 'polite')
    } catch {
      // Status stays as it was.
    } finally {
      setBusy(null)
    }
  }

  const showAddon = async (): Promise<void> => {
    const r = await invoke('bridges:blender-addon')
    const text = r.ok
      ? 'The add-on file is selected in File Explorer: lumen_bridge.zip.'
      : (r.error ?? 'Could not make the add-on file.')
    setAddonMsg(text)
    announce(text, r.ok ? 'polite' : 'assertive')
  }

  const obs = status.obs
  const portNum = port.trim() ? Number(port) : undefined
  const portOk =
    portNum === undefined || (Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535)

  const saveObs = async (): Promise<void> => {
    const r = await invoke('bridges:obs-set', {
      ...(password ? { password } : {}),
      ...(portNum !== undefined ? { port: portNum } : {})
    })
    setPassword('')
    setObsMsg(
      r.persisted
        ? 'Saved, encrypted, on this PC.'
        : 'Saved until Lumen closes (Windows encryption is not available).'
    )
    await test('obs')
  }

  return (
    <>
      <Card
        title="Blender"
        description="A small free add-on lets lessons see Blender’s mode, selection and last action, so steps are checked exactly instead of from screenshots. It only answers questions from this PC and cannot change your scene."
      >
        <StatusLine s={status.blender} />
        <ol className="ui-hint">
          <li>Click “Show the add-on file”. Lumen saves lumen_bridge.zip and opens its folder.</li>
          <li>In Blender, open Edit, Preferences, Get Extensions (Add-ons in Blender 3.6).</li>
          <li>
            Open the menu at the top right, choose “Install from Disk”, and pick lumen_bridge.zip.
          </li>
          <li>Make sure “Lumen Bridge” is ticked, then click Test here.</li>
        </ol>
        <div className="panel-row">
          <Button icon={icons.download} onClick={() => void showAddon()}>
            Show the add-on file
          </Button>
          <Button
            busy={busy === 'blender'}
            disabled={busy === 'blender'}
            onClick={() => void test('blender')}
          >
            Test
          </Button>
        </div>
        {addonMsg && <p className="ui-hint">{addonMsg}</p>}
      </Card>

      <Card
        title="OBS Studio"
        description="OBS 28 and later have a built-in WebSocket server. With it on, lessons can see whether you are recording, which scene is live and which sources exist."
      >
        <StatusLine s={obs} />
        <ol className="ui-hint">
          <li>In OBS, open Tools, WebSocket Server Settings, and tick Enable WebSocket server.</li>
          <li>Click Show Connect Info and copy the server password.</li>
          <li>Paste it below and click Save and test.</li>
        </ol>
        <Field
          label="OBS WebSocket password"
          hint={
            obs?.hasPassword
              ? 'A password is saved. Paste a new one to replace it.'
              : 'Stored encrypted on this PC and never shown again.'
          }
        >
          {(a) => (
            <input
              {...a}
              type="password"
              className="ui-input ui-input--mono"
              autoComplete="off"
              spellCheck={false}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && portOk) void saveObs()
              }}
            />
          )}
        </Field>
        <Field
          label="Server port"
          hint={`Leave empty for ${obs?.port ?? 4455}.`}
          error={portOk ? undefined : 'Use a number from 1024 to 65535.'}
        >
          {(a) => (
            <input
              {...a}
              inputMode="numeric"
              className="ui-input"
              placeholder={String(obs?.port ?? 4455)}
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          )}
        </Field>
        <div className="panel-row">
          <Button
            variant="primary"
            icon={icons.key}
            busy={busy === 'obs'}
            disabled={busy === 'obs' || !portOk}
            onClick={() => void saveObs()}
          >
            Save and test
          </Button>
          <Button disabled={busy === 'obs'} onClick={() => void test('obs')}>
            Test
          </Button>
          {obs?.hasPassword && (
            <Button
              variant="quiet"
              icon={icons.trash}
              onClick={() => {
                invoke('bridges:obs-clear')
                  .then(() => {
                    setObsMsg('Password removed.')
                    announce('Password removed')
                    refresh()
                  })
                  .catch(() => {})
              }}
            >
              Remove password
            </Button>
          )}
        </div>
        {obsMsg && <p className="ui-hint">{obsMsg}</p>}
      </Card>

      <Card
        title="DaVinci Resolve"
        description="Resolve lessons check steps from the screen. Only the paid Studio edition can be connected, and that is not built yet."
      />
    </>
  )
}
