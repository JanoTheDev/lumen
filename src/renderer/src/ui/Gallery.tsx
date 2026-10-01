// Dev-only page that shows every component in its states, in each theme and scale.
import { useEffect, useState } from 'react'
import { applyTheme } from '../theme/apply'
import {
  Button,
  Card,
  ConfirmCard,
  Countdown,
  Field,
  IconButton,
  Kbd,
  LiveRegion,
  Markdown,
  NavList,
  NumberField,
  ProgressBar,
  SegmentedControl,
  Select,
  Slider,
  StepList,
  Switch,
  TextField,
  Thinking,
  Toast,
  icons
} from '.'

type GalleryTheme = 'light' | 'dark' | 'high-contrast'

const SAMPLE_MD = `The **Compose** button is at the top left. I'll point at it.

- You can also press \`C\`
- Or open [Gmail help](https://support.google.com/mail)

\`\`\`
Ctrl + Enter sends
\`\`\``

export function Gallery(): JSX.Element {
  const [theme, setTheme] = useState<GalleryTheme>('dark')
  const [scale, setScale] = useState(1)
  const [on, setOn] = useState(true)
  const [num, setNum] = useState(1500)
  const [text, setText] = useState('hey lumen')
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('a')
  const [sel, setSel] = useState<'one' | 'two'>('one')
  const [nav, setNav] = useState<'general' | 'voice' | 'look'>('general')
  const [log, setLog] = useState('')
  const [run, setRun] = useState(0)

  useEffect(() => {
    applyTheme({ theme, a11y: { uiScale: scale } }, { scaleText: true })
  }, [theme, scale])

  return (
    <main className="gallery">
      <LiveRegion />
      <h1>Component gallery</h1>
      <div className="gallery__bar">
        <SegmentedControl
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'high-contrast', label: 'High contrast' }
          ]}
        />
        <Slider
          label="UI scale"
          value={scale}
          min={0.75}
          max={2}
          step={0.25}
          onChange={setScale}
          format={(v) => `${Math.round(v * 100)} percent`}
        />
      </div>

      <Card title="Buttons" description="Primary, secondary, quiet, danger; busy and disabled.">
        <div className="gallery__row">
          <Button variant="primary">Save</Button>
          <Button>Test</Button>
          <Button variant="quiet">Cancel</Button>
          <Button variant="danger" icon={icons.trash}>
            Delete
          </Button>
          <Button variant="primary" busy>
            Installing
          </Button>
          <Button disabled>Disabled</Button>
          <Button size="lg" variant="primary">
            Large
          </Button>
        </div>
        <div className="gallery__row">
          <IconButton icon={icons.repeat} label="Repeat" shortcut="Ctrl+R" />
          <IconButton icon={icons.copy} label="Copy" />
          <IconButton icon={icons.pin} label="Pin" pressed />
          <IconButton icon={icons.close} label="Close" variant="danger" />
        </div>
      </Card>

      <Card title="Inputs">
        <Switch checked={on} onChange={setOn} label="Wake word" hint="Listen for “hey lumen”." />
        <Switch checked={false} onChange={() => {}} label="Disabled switch" disabled />
        <TextField
          label="Wake phrase"
          value={text}
          onCommit={setText}
          hint="Saved after a pause."
        />
        <TextField
          label="Accent colour"
          value="#12"
          onCommit={() => {}}
          accept={(v) => /^#[0-9a-f]{6}$/i.test(v)}
          mono
        />
        <NumberField
          label="Silence before stop"
          value={num}
          onCommit={setNum}
          min={400}
          max={5000}
          step={100}
          unit="ms"
        />
        <Select
          label="Voice"
          value={sel}
          onChange={setSel}
          options={[
            { value: 'one', label: 'Windows voice' },
            { value: 'two', label: 'Cloud voice' }
          ]}
        />
        <SegmentedControl
          label="Size"
          value={seg}
          onChange={setSeg}
          options={[
            { value: 'a', label: 'Small' },
            { value: 'b', label: 'Medium' },
            { value: 'c', label: 'Large' }
          ]}
        />
        <Field label="With error" error="Key was rejected. Check it and try again.">
          {(a) => <input {...a} className="ui-input" defaultValue="sk-wrong" />}
        </Field>
      </Card>

      <Card title="Status">
        <div className="gallery__row">
          <Thinking />
          <Kbd combo="Ctrl+Shift+Space" />
        </div>
        <ProgressBar label="Downloading voice model" value={0.42} />
        <ProgressBar label="Extracting" />
        <StepList
          steps={[
            { label: 'Open Gmail', state: 'done' },
            { label: 'Click Compose', state: 'active' },
            { label: 'Fill subject', state: 'pending' },
            { label: 'Send', state: 'failed' }
          ]}
          horizontal
        />
        <Toast kind="success" onDismiss={() => {}}>
          Saved
        </Toast>
        <Toast kind="error" action={{ label: 'Retry', onClick: () => {} }}>
          Couldn’t reach the server.
        </Toast>
      </Card>

      <Card title="Countdown and confirm">
        <Button onClick={() => setRun((r) => r + 1)}>Restart</Button>
        <Countdown
          key={`c${run}`}
          durationMs={5000}
          label={(s) => `Clicking Send in ${s}`}
          onDone={() => setLog('Countdown done')}
          onCancel={() => setLog('Countdown cancelled')}
        />
        <ConfirmCard
          key={`m${run}`}
          summary="About to send the email to Sam"
          risk="medium"
          countdownMs={4000}
          confirmLabel="Send now"
          countdownVerb="Sending"
          onConfirm={() => setLog('Confirmed')}
          onDeny={() => setLog('Denied')}
        />
        <ConfirmCard
          key={`h${run}`}
          summary="About to delete 14 files"
          risk="high"
          confirmLabel="Delete"
          onConfirm={() => setLog('High risk confirmed')}
          onDeny={() => setLog('High risk denied')}
        />
        <p className="ui-hint" role="status">
          {log || 'No decision yet'}
        </p>
      </Card>

      <Card title="Navigation and Markdown">
        <NavList
          label="Example sections"
          current={nav}
          onSelect={setNav}
          items={[
            { id: 'general', label: 'General', icon: icons.settings },
            { id: 'voice', label: 'Voice', icon: icons.mic },
            { id: 'look', label: 'Buddy & look', icon: icons.palette }
          ]}
        />
        <Markdown source={SAMPLE_MD} onLink={(u) => setLog(`Link: ${u}`)} />
      </Card>
    </main>
  )
}
