// Home dictation history (04 T44): recent dictations with app, time and the transcript when
// cleanup changed it; copy, type again (into the field the user returns to), delete, clear
// all and the keep-history switch. Collapsed by default.
import { useCallback, useEffect, useState } from 'react'
import type { DictationHistoryView } from '@shared/dictation-history'
import { Button, IconButton, Switch, icons } from '../../ui'
import { invoke, send, useIpc } from '../../lib/ipc'
import { canTypeAgain, heardText, historyMeta } from './dictation-view'

const SHOWN = 20

function useHistory(): [DictationHistoryView | null, () => void] {
  const [view, setView] = useState<DictationHistoryView | null>(null)
  const refresh = useCallback((): void => {
    invoke('dictation:history')
      .then((v) => v && Array.isArray(v.entries) && setView(v))
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])
  useIpc('home:shown', refresh)
  return [view, refresh]
}

export function DictationHistory({
  onEnabled
}: {
  onEnabled: (on: boolean) => void
}): JSX.Element | null {
  const [view, refresh] = useHistory()
  const [confirmClear, setConfirmClear] = useState(false)
  if (!view) return null
  const entries = view.entries.slice(0, SHOWN)
  return (
    <section className="home-section" aria-labelledby="home-dictation">
      <details className="home-details">
        <summary>
          <h2 id="home-dictation" className="home-label">
            Dictation history
            {view.entries.length > 0 && ` (${view.entries.length})`}
          </h2>
        </summary>
        <div className="home-details__body">
          <Switch
            checked={view.enabled}
            onChange={(on) => {
              onEnabled(on)
              setTimeout(refresh, 150)
            }}
            label="Keep dictation history"
            hint="Only on this computer. Secrets are hidden, entries go after 30 days."
          />
          {entries.length === 0 ? (
            <p className="home-empty">Nothing dictated yet.</p>
          ) : (
            <ul className="home-notes">
              {entries.map((e) => {
                const heard = heardText(e)
                return (
                  <li key={e.id} className="home-note">
                    <div className="home-note__body">
                      <span className="home-note__text">{e.text}</span>
                      {heard && <span className="home-note__heard">Heard: {heard}</span>}
                      <span className="home-note__meta">{historyMeta(e)}</span>
                    </div>
                    <span className="home-note__actions">
                      <IconButton
                        icon={icons.copy}
                        label="Copy"
                        onClick={() => void invoke('dictation:history-copy', e.id).catch(() => {})}
                      />
                      {canTypeAgain(e) && (
                        <IconButton
                          icon={icons.repeat}
                          label="Type it again"
                          onClick={() => {
                            send('panel:close')
                            void invoke('dictation:history-insert', e.id).catch(() => {})
                          }}
                        />
                      )}
                      <IconButton
                        icon={icons.trash}
                        label="Delete"
                        variant="danger"
                        onClick={() => {
                          void invoke('dictation:history-delete', e.id)
                            .then(refresh)
                            .catch(() => {})
                        }}
                      />
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {view.entries.length > 0 &&
            (confirmClear ? (
              <span className="home-note__actions">
                <Button
                  variant="danger"
                  onClick={() => {
                    setConfirmClear(false)
                    void invoke('dictation:history-clear')
                      .then(refresh)
                      .catch(() => {})
                  }}
                >
                  Clear all history
                </Button>
                <Button variant="quiet" onClick={() => setConfirmClear(false)}>
                  Keep it
                </Button>
              </span>
            ) : (
              <Button variant="quiet" onClick={() => setConfirmClear(true)}>
                Clear history…
              </Button>
            ))}
        </div>
      </details>
    </section>
  )
}
