// Import a buddy from a `.lumen` file (08 T51/T53): what each one may do first, then install.
// Imported buddies are community-untrusted: they confirm every risky action.
import { useRef, useState } from 'react'
import type { BuddyImportPreview } from '@shared/buddies'
import { Button, announce } from '../../../ui'
import { BuddiesAvatar } from './BuddiesAvatar'
import { PermissionList } from './BuddiesFields'

type Ready = Extract<BuddyImportPreview, { ok: true }>

export function BuddiesImport({ onDone }: { onDone: (ids: string[]) => void }): JSX.Element {
  const [preview, setPreview] = useState<Ready | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const headRef = useRef<HTMLHeadingElement>(null)

  const pick = async (): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      const r = await window.lumen.invoke('buddies:import-preview')
      if (r.ok) {
        setPreview(r)
        announce(`${r.buddies.length === 1 ? 'One buddy' : `${r.buddies.length} buddies`} to check`)
        requestAnimationFrame(() => headRef.current?.focus())
      } else if (r.error !== 'cancelled') {
        const text = [r.error, ...(r.problems ?? [])].join(' ')
        setMsg(`Not imported: ${text}`)
        announce(`Not imported: ${r.error}`, 'assertive')
      }
    } catch {
      setMsg('Not imported: something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const install = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      const r = await window.lumen.invoke('buddies:import', { token: preview.token })
      if (r.ok) {
        const names = r.installed.map((b) => b.name).join(', ')
        setMsg(`Imported ${names}.`)
        announce(`Imported ${names}`)
        setPreview(null)
        onDone(r.installed.map((b) => b.id))
      } else {
        setMsg(`Not imported: ${[r.error, ...(r.problems ?? [])].join(' ')}`)
        announce(`Not imported: ${r.error}`, 'assertive')
      }
    } catch {
      setMsg('Not imported: something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bd-import">
      {!preview && (
        <Button busy={busy} disabled={busy} onClick={pick}>
          Import a buddy…
        </Button>
      )}
      {preview && (
        <section aria-labelledby="bd-import-head" className="bd-review">
          <h3 id="bd-import-head" ref={headRef} tabIndex={-1}>
            Import {preview.buddies.length === 1 ? 'this buddy' : 'these buddies'}?
          </h3>
          <p className="ui-hint">
            Buddies from a file are community buddies: they ask before every risky action.
          </p>
          <ul className="panel-list">
            {preview.buddies.map((b) => (
              <li key={b.id} className="bd-import__item">
                <div className="bd-import__head">
                  <BuddiesAvatar look={b.look} name={b.name} />
                  <span className="panel-list__title">{b.name}</span>
                  <span className="bd-badge">community, untrusted</span>
                  {b.updates && <span className="ui-hint">replaces the earlier import</span>}
                </div>
                {b.description && <p className="ui-hint">{b.description}</p>}
                <PermissionList permissions={b.permissions} />
                <p className="ui-hint">
                  Budget: ${b.budget.perRunUsd.toFixed(2)} a run
                  {b.budget.perMonthUsd !== undefined
                    ? `, $${b.budget.perMonthUsd.toFixed(2)} a month`
                    : ', no monthly limit'}
                </p>
                {b.notes.map((n) => (
                  <p key={n} className="ui-hint">
                    {n}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          <div className="panel-row">
            <Button variant="primary" busy={busy} disabled={busy} onClick={install}>
              Import
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setPreview(null)
                announce('Import cancelled')
              }}
            >
              Cancel
            </Button>
          </div>
        </section>
      )}
      {msg && (
        <p className="ui-hint" role="status">
          {msg}
        </p>
      )}
    </div>
  )
}
