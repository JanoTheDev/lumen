// Community lesson packs (07 T32): install a `.lumen` file or a GitHub link, list and remove
// installed packs, and export any app's pack to share it.
import { useCallback, useEffect, useState } from 'react'
import type { CommunityPackInfo, PackInstallResult } from '@shared/channels'
import { Button, Card, IconButton, announce, icons } from '../../../ui'

export function CommunityPacks({
  apps,
  onChanged
}: {
  /** Apps with a full pack, for export. */
  apps: { appId: string; appName: string }[]
  onChanged: () => void
}): JSX.Element {
  const [packs, setPacks] = useState<CommunityPackInfo[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const [exportId, setExportId] = useState('')

  const refresh = useCallback(() => {
    window.lumen
      .invoke('teach:pack-list')
      .then(setPacks)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])

  const report = (res: PackInstallResult): void => {
    if (res.ok) {
      const names = res.installed.map((p) => `${p.name}${p.updated ? ' (updated)' : ''}`)
      const text = `Installed ${names.join(', ')}`
      setMsg(text)
      setProblems([])
      announce(text)
      refresh()
      onChanged()
    } else if (res.error !== 'cancelled') {
      setMsg(`Not installed: ${res.error}`)
      setProblems(res.problems ?? [])
      announce(`Not installed: ${res.error}`, 'assertive')
    }
  }

  const run = async (p: Promise<PackInstallResult>): Promise<void> => {
    setBusy(true)
    try {
      report(await p)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Community lesson packs"
      description="Lesson packs other people made, as a .lumen file or a GitHub link. Packs hold only text and pictures, never programs, and are checked before they install. Community packs are marked untrusted: Lumen will not do their steps for you."
    >
      <div className="panel-row">
        <Button
          icon={icons.download}
          busy={busy}
          onClick={() => run(window.lumen.invoke('teach:pack-install-file'))}
        >
          Install from a file
        </Button>
      </div>
      <div className="panel-row panel-row--end">
        <div className="ui-field">
          <label htmlFor="pack-url" className="ui-field__label">
            GitHub link
          </label>
          <input
            id="pack-url"
            className="ui-input"
            type="url"
            value={url}
            placeholder="https://github.com/someone/lumen-packs"
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <Button
          busy={busy}
          disabled={!url.trim()}
          onClick={() => run(window.lumen.invoke('teach:pack-install-url', url.trim()))}
        >
          Install
        </Button>
      </div>
      {msg && (
        <p className="ui-hint" role="status">
          {msg}
        </p>
      )}
      {problems.length > 0 && (
        <ul className="ui-hint" aria-label="Problems found">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {packs.length > 0 && (
        <ul className="panel-list" aria-label="Installed community packs">
          {packs.map((p) => (
            <li key={p.id} className="panel-list__item">
              <div className="panel-list__text">
                <span className="panel-list__title">{p.name}</span>
                <span className="ui-hint">
                  community, untrusted · {p.lessons} lessons · from {p.source}
                  {p.loaded ? '' : ' · did not load, see the log'}
                </span>
              </div>
              <IconButton
                icon={icons.trash}
                label={`Remove ${p.name}`}
                variant="danger"
                onClick={async () => {
                  await window.lumen.invoke('teach:pack-remove', p.id)
                  announce(`Removed ${p.name}`)
                  refresh()
                  onChanged()
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {apps.length > 0 && (
        <div className="panel-row panel-row--end">
          <div className="ui-field">
            <label htmlFor="pack-export" className="ui-field__label">
              Share a pack
            </label>
            <select
              id="pack-export"
              className="ui-input"
              value={exportId}
              onChange={(e) => setExportId(e.target.value)}
            >
              <option value="">Choose an app</option>
              {apps.map((a) => (
                <option key={a.appId} value={a.appId}>
                  {a.appName}
                </option>
              ))}
            </select>
          </div>
          <Button
            disabled={!exportId}
            onClick={async () => {
              const r = await window.lumen.invoke('teach:pack-export', exportId)
              if (r.ok) announce('Pack saved')
              else if (r.error !== 'cancelled') announce(`Not saved: ${r.error}`, 'assertive')
              setMsg(r.ok ? `Saved to ${r.path}` : r.error === 'cancelled' ? msg : `${r.error}`)
            }}
          >
            Save as .lumen
          </Button>
        </div>
      )}
    </Card>
  )
}
