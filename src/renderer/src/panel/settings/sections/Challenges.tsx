// Settings → Lessons → Practice challenges (11 T22): a short exercise in your own app, made
// for your level, checked from one screenshot when you say "check my work". Streak and recent
// results; all kept on this PC.
import { useCallback, useEffect, useState } from 'react'
import type { ChallengeView } from '@shared/channels'
import { Button, Card, Select, announce } from '../../../ui'

type Level = 'auto' | 'beginner' | 'intermediate' | 'advanced'

export function Challenges({ apps }: { apps: { appId: string; appName: string }[] }): JSX.Element {
  const [view, setView] = useState<ChallengeView | null>(null)
  const [app, setApp] = useState('')
  const [level, setLevel] = useState<Level>('auto')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    window.lumen
      .invoke('teach:challenge-status')
      .then(setView)
      .catch(() => setView(null))
  }, [])
  useEffect(load, [load])

  const say = (text: string): void => {
    setMsg(text)
    announce(text)
  }
  const run = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true)
    try {
      say(await fn())
    } finally {
      setBusy(false)
      load()
    }
  }
  const start = (): Promise<void> =>
    run(async () => {
      const r = await window.lumen.invoke('teach:challenge-start', {
        ...(app ? { app } : {}),
        ...(level !== 'auto' ? { level } : {})
      })
      return r.ok ? 'Challenge ready. It is shown in the bar.' : `No challenge: ${r.error}`
    })
  const check = (): Promise<void> =>
    run(async () => (await window.lumen.invoke('teach:challenge-check')).text)
  const stop = (): Promise<void> =>
    run(async () => {
      await window.lumen.invoke('teach:challenge-stop')
      return 'Challenge stopped.'
    })

  const a = view?.active
  return (
    <Card
      title="Practice challenges"
      description="Say “give me a challenge” in an app, or “a harder challenge”. Do it your way, then say “check my work”: a screenshot is sent to the AI only then, and you hear what went well and what to fix."
    >
      {view && (
        <p>
          Streak: {view.streak} {view.streak === 1 ? 'day' : 'days'} (best {view.best}). Passed:{' '}
          {view.passed}.
        </p>
      )}
      {a ? (
        <>
          <p>
            <strong>{a.title}</strong> ({a.appName}, {a.level}, {a.minutes} min): {a.goal}
          </p>
          <ul className="panel-list" aria-label="What is checked">
            {a.rubric.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <Button variant="primary" disabled={busy} onClick={() => void check()}>
            Check my work
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => void stop()}>
            Give up
          </Button>
        </>
      ) : (
        <>
          <Select
            label="App"
            value={app}
            options={[
              { value: '', label: 'The app in front' },
              ...apps.map((x) => ({ value: x.appId, label: x.appName }))
            ]}
            onChange={setApp}
          />
          <Select<Level>
            label="Level"
            value={level}
            options={[
              { value: 'auto', label: 'From my progress' },
              { value: 'beginner', label: 'Beginner' },
              { value: 'intermediate', label: 'Intermediate' },
              { value: 'advanced', label: 'Advanced' }
            ]}
            onChange={setLevel}
          />
          <Button variant="primary" disabled={busy} onClick={() => void start()}>
            Start a challenge
          </Button>
        </>
      )}
      {msg && <p role="status">{msg}</p>}
      {view && view.recent.length > 0 && (
        <details>
          <summary>Recent results</summary>
          <ul className="panel-list">
            {view.recent.map((r) => (
              <li key={`${r.id}-${r.finishedAt}`}>
                {r.passed ? 'Passed' : 'Not yet'}: {r.title} ({r.met}/{r.total}). {r.feedback}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}
