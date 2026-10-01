// Settings → Lessons → Lesson from a tutorial (11 T12): paste a transcript, give a web
// tutorial's address or open a subtitle file; the AI turns it into a lesson draft that is
// reviewed like a recording (Record my steps). YouTube is not read directly (its terms do not
// allow it): copy the video's transcript instead.
import { useState } from 'react'
import type { TutorialImportRequest } from '@shared/channels'
import { Button, Card, Field, Select, TextField, announce } from '../../../ui'

export function LessonImport({
  apps,
  onDraft
}: {
  apps: { appId: string; appName: string }[]
  onDraft: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [app, setApp] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const run = async (req: TutorialImportRequest): Promise<void> => {
    setBusy(true)
    setMsg('Reading the tutorial and writing the lesson…')
    try {
      const r = await window.lumen.invoke('teach:import-tutorial', {
        ...req,
        ...(app ? { appId: app } : {})
      })
      if (r.error === 'cancelled') {
        setMsg('')
        return
      }
      const out = r.ok
        ? `Draft ready: “${r.title}” for ${r.appName}, ${r.steps} steps. Review it under Record my steps.${r.drift ? ` ${r.drift}` : ''}`
        : `No lesson: ${r.error}`
      setMsg(out)
      announce(out, r.ok ? 'polite' : 'assertive')
      if (r.ok) onDraft()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Lesson from a tutorial"
      description="Turn a tutorial into a lesson you follow in your own app, step by step. The text is sent to the AI to find the steps. For a YouTube video, open its transcript, copy it and paste it here."
    >
      <Select
        label="App"
        value={app}
        options={[
          { value: '', label: 'Let the tutorial say' },
          ...apps.map((a) => ({ value: a.appId, label: a.appName }))
        ]}
        onChange={setApp}
      />
      <Field label="Transcript or tutorial text">
        {(a) => (
          <textarea
            {...a}
            className="ui-input ui-input--multi"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </Field>
      <Button
        disabled={busy || text.trim().length < 20}
        onClick={() => void run({ kind: 'text', text })}
      >
        Make a lesson from this text
      </Button>
      <TextField
        label="Web tutorial address"
        type="url"
        value={url}
        onCommit={setUrl}
        announceSave={false}
        placeholder="https://"
        hint="Only pages whose site allows automatic reading (robots.txt) are read."
      />
      <Button
        disabled={busy || !/^https:\/\/\S+$/.test(url.trim())}
        onClick={() => void run({ kind: 'url', url: url.trim() })}
      >
        Make a lesson from this page
      </Button>
      <Button disabled={busy} onClick={() => void run({ kind: 'file' })}>
        Open a subtitle file (.srt, .vtt)
      </Button>
      {msg && <p role="status">{msg}</p>}
    </Card>
  )
}
