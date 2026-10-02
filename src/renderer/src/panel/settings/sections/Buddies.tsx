// Settings → Buddies (08 T53): little helpers with a job. The list (on/off, run now, stop, pause
// all), "Make a buddy for me", import, and one buddy's page at #/settings/buddies/<id>.
import { useCallback, useEffect, useState } from 'react'
import type { BuddiesView, BuddyRow } from '@shared/buddy-views'
import { Card, IconButton, Switch, announce, icons } from '../../../ui'
import { useIpc } from '../../../lib/ipc'
import { BuddiesAvatar } from './BuddiesAvatar'
import { BuddiesCompose } from './BuddiesCompose'
import { BuddiesDetail } from './BuddiesDetail'
import { BuddiesImport } from './BuddiesImport'
import { buddyFromHash, nextRunLine, stateLine } from './buddies-view'

const LIST_HASH = '#/settings/buddies'

function useSub(): [string | null, (sub: string | null) => void] {
  const [sub, setSub] = useState(() => buddyFromHash(location.hash))
  useEffect(() => {
    const on = (): void => setSub(buddyFromHash(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [sub, (next) => (location.hash = next ? `${LIST_HASH}/${next}` : LIST_HASH)]
}

function useBuddies(): [BuddiesView | null, () => void] {
  const [view, setView] = useState<BuddiesView | null>(null)
  const refresh = useCallback((): void => {
    window.lumen
      .invoke('buddies:list')
      .then((v) => v && 'buddies' in v && setView(v))
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  useIpc('buddies:changed', refresh)
  return [view, refresh]
}

function Row({
  b,
  onOpen,
  onChanged
}: {
  b: BuddyRow
  onOpen: () => void
  onChanged: () => void
}): JSX.Element {
  const working = b.running || b.onScreen
  const meta = [stateLine(b), b.enabled ? nextRunLine(b.nextRunAt) : ''].filter(Boolean)
  const run = async (): Promise<void> => {
    const r = await window.lumen.invoke('buddies:run', { id: b.id }).catch(() => null)
    announce(
      r?.ok ? `${b.name} is working` : `Not started: ${r?.error ?? 'something went wrong'}`,
      r?.ok ? 'polite' : 'assertive'
    )
    onChanged()
  }
  return (
    <li className="panel-list__item bd-row">
      <BuddiesAvatar look={b.look} name={b.name} />
      <button type="button" className="bd-row__main" onClick={onOpen}>
        <span className="panel-list__title">{b.name}</span>
        <span className="ui-hint">{meta.join(' · ')}</span>
        {b.trust === 'community-untrusted' && (
          <span className="bd-badge">community, untrusted</span>
        )}
      </button>
      <Switch
        checked={b.enabled}
        onChange={(enabled) => {
          void window.lumen
            .invoke('buddies:set-enabled', { id: b.id, enabled })
            .then(() => announce(enabled ? `${b.name} is on` : `${b.name} is off`))
            .catch(() => {})
            .finally(onChanged)
        }}
        label={<span className="visually-hidden">{b.name} on</span>}
      />
      {working ? (
        <IconButton
          icon={icons.square}
          label={`Stop ${b.name}`}
          onClick={() =>
            void window.lumen
              .invoke('buddies:stop', b.id)
              .then(() => announce(`Stopped ${b.name}`))
              .catch(() => {})
              .finally(onChanged)
          }
        />
      ) : (
        <IconButton
          icon={icons.play}
          label={`Run ${b.name} now`}
          disabled={!b.enabled}
          onClick={() => void run()}
        />
      )}
    </li>
  )
}

export function Buddies(): JSX.Element {
  const [sub, go] = useSub()
  const [view, refresh] = useBuddies()

  if (sub && sub !== '_new') return <BuddiesDetail id={sub} onBack={() => go(null)} />

  const list = view?.buddies ?? []
  return (
    <>
      <Card
        title="Your buddies"
        description="Helpers with a job. Call one by name (“Inbox Buddy, what’s new?”) or give it a schedule."
      >
        {view && (
          <Switch
            checked={view.pausedAll}
            onChange={(paused) => {
              void window.lumen
                .invoke('buddies:pause-all', paused)
                .then(() =>
                  announce(paused ? 'Scheduled buddy runs paused' : 'Scheduled buddy runs back on')
                )
                .catch(() => {})
                .finally(refresh)
            }}
            label="Pause all buddies"
            hint="Scheduled runs wait. Calling a buddy by name still works."
          />
        )}
        {!view ? (
          <p className="ui-hint">Loading…</p>
        ) : list.length ? (
          <ul className="panel-list" aria-label="Buddies">
            {list.map((b) => (
              <Row key={b.id} b={b} onOpen={() => go(b.id)} onChanged={refresh} />
            ))}
          </ul>
        ) : (
          <p className="ui-hint">No buddies yet. Make one below, or say “make a buddy that …”.</p>
        )}
        <BuddiesImport onDone={(ids) => (ids.length === 1 ? go(ids[0]) : refresh())} />
      </Card>
      <BuddiesCompose autoFocus={sub === '_new'} onSaved={(id) => go(id)} />
    </>
  )
}
