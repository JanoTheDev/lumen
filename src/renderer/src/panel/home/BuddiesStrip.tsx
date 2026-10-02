// Home flyout Buddies strip (08 T53): each buddy's avatar, name, state or last result and next
// run; a row opens its page in Settings → Buddies. Without buddies only "Make a buddy" shows.
import { useCallback, useEffect, useState } from 'react'
import type { BuddiesView } from '@shared/buddy-views'
import { Button } from '../../ui'
import { invoke, send, useIpc } from '../../lib/ipc'
import { BuddiesAvatar } from '../settings/sections/BuddiesAvatar'
import { nextRunLine, stateLine } from '../settings/sections/buddies-view'

const SHOWN = 5

function useBuddies(): BuddiesView | null {
  const [view, setView] = useState<BuddiesView | null>(null)
  const refresh = useCallback((): void => {
    invoke('buddies:list')
      .then((v) => v && 'buddies' in v && setView(v))
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  useIpc('home:shown', refresh)
  useIpc('buddies:changed', refresh)
  return view
}

const open = (sub: string): void => send('panel:open', `settings/buddies${sub ? `/${sub}` : ''}`)

export function BuddiesStrip(): JSX.Element | null {
  const view = useBuddies()
  if (!view) return null
  const list = view.buddies
  if (!list.length)
    return (
      <div className="home-buddies__empty">
        <Button variant="quiet" onClick={() => open('_new')}>
          Make a buddy
        </Button>
      </div>
    )
  // Working ones first, then the rest in their own order.
  const rows = [...list].sort((a, b) => +(b.running || b.onScreen) - +(a.running || a.onScreen))
  return (
    <section className="home-section" aria-labelledby="home-buddies">
      <div className="home-tasks__head">
        <h2 id="home-buddies" className="home-label">
          Buddies{view.pausedAll ? ' (paused)' : ''}
        </h2>
        <Button variant="quiet" onClick={() => open(list.length > SHOWN ? '' : '_new')}>
          {list.length > SHOWN ? 'All buddies' : 'Make a buddy'}
        </Button>
      </div>
      <ul className="home-buddies">
        {rows.slice(0, SHOWN).map((b) => {
          const next = b.enabled ? nextRunLine(b.nextRunAt) : ''
          const working = b.running || b.onScreen
          return (
            <li key={b.id}>
              <button
                type="button"
                className={`home-buddy${working ? ' is-working' : ''}${b.enabled ? '' : ' is-off'}`}
                onClick={() => open(b.id)}
              >
                <BuddiesAvatar look={b.look} name={b.name} />
                <span className="home-buddy__text">
                  <span className="home-buddy__name">{b.name}</span>
                  <span className="home-buddy__meta" aria-live="polite">
                    {stateLine(b)}
                  </span>
                  {next && <span className="home-buddy__meta">{next}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
