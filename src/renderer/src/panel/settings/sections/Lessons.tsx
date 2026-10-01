import { useCallback, useEffect, useState } from 'react'
import type { SavedGuide } from '@shared/types'
import { Button, Card, IconButton, announce, icons } from '../../../ui'

export function Lessons(): JSX.Element {
  const [guides, setGuides] = useState<SavedGuide[]>([])
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  const refresh = useCallback(() => {
    window.lumen
      .invoke('guides:list')
      .then(setGuides)
      .catch(() => {})
  }, [])
  useEffect(refresh, [refresh])

  const save = async (): Promise<void> => {
    const res = await window.lumen.invoke('guides:save-last', name.trim())
    const text = 'error' in res ? res.error : `Saved “${res.name}”`
    setMsg(text)
    announce(text, 'error' in res ? 'assertive' : 'polite')
    if (!('error' in res)) {
      setName('')
      refresh()
    }
  }

  return (
    <>
      <Card
        title="Save the last guide"
        description="After Lumen walks you through something, save it to replay later. You can also say “save guide as” and a name."
      >
        <div className="panel-row panel-row--end">
          <div className="ui-field">
            <label htmlFor="guide-name" className="ui-field__label">
              Name
            </label>
            <input
              id="guide-name"
              className="ui-input"
              value={name}
              placeholder="Compose in Gmail"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
              }}
            />
          </div>
          <Button variant="primary" onClick={save}>
            Save guide
          </Button>
        </div>
        {msg && <p className="ui-hint">{msg}</p>}
      </Card>

      <Card
        title="Saved guides"
        description={
          guides.length
            ? `${guides.length} saved. Say “play guide” and a name to run one.`
            : 'Nothing saved yet.'
        }
      >
        {guides.length > 0 && (
          <ul className="panel-list">
            {guides.map((g) => (
              <li key={g.id} className="panel-list__item">
                <div className="panel-list__text">
                  <span className="panel-list__title">{g.name}</span>
                  <span className="ui-hint">
                    {g.steps.length} {g.steps.length === 1 ? 'step' : 'steps'} ·{' '}
                    {new Date(g.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <IconButton
                  icon={icons.play}
                  label={`Play ${g.name}`}
                  onClick={() => {
                    window.lumen.invoke('guides:replay', g.id).catch(() => {})
                    window.lumen.send('settings:window-minimize')
                  }}
                />
                <IconButton
                  icon={icons.trash}
                  label={`Delete ${g.name}`}
                  variant="danger"
                  onClick={async () => {
                    await window.lumen.invoke('guides:delete', g.id)
                    announce(`Deleted ${g.name}`)
                    refresh()
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
