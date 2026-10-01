// The onboarding steps. Each renders its content only; Onboarding.tsx owns the heading,
// progress and Back / Skip / Continue.
import { useEffect, useState } from 'react'
import type { SttStatus, WakeModelProgress } from '@shared/channels'
import type { ProfileId } from '@shared/profiles'
import { Button, Field, Kbd, ProgressBar, Select, announce, icons } from '../../ui'
import { invoke, send } from '../../lib/ipc'
import type { Config, Patch } from '../settings/useConfig'
import { MicTest } from '../settings/sections/MicTest'
import { useMicDevices } from '../settings/sections/use-mic-devices'
import { KeyForm } from '../settings/sections/KeyForm'
import { micOptions } from '../settings/sections/voice-options'
import { PRESET_CARDS, toggleChoice } from './presets'
import { talkHint } from './flow'

// ---- 1. Profile ----

export function ProfileStep({
  chosen,
  onChange,
  preview
}: {
  chosen: ProfileId[]
  onChange: (next: ProfileId[]) => void
  preview: string[]
}): JSX.Element {
  return (
    <div className="ob-profile">
      <p className="ob-lead">
        Pick everything that fits. Click, press Space, rest the pointer on a card, or wait and press
        Space when the one you want is highlighted.
      </p>
      <div className="ob-cards" role="group" aria-label="What would help you">
        {PRESET_CARDS.map((c) => {
          const Icon = icons[c.icon]
          const on = chosen.includes(c.id)
          return (
            <button
              key={c.id}
              type="button"
              data-choose
              className={`ob-card${on ? ' is-on' : ''}`}
              aria-pressed={on}
              onClick={() => {
                onChange(toggleChoice(chosen, c.id))
                announce(`${c.title}: ${on ? 'off' : 'on'}`)
              }}
            >
              <span className="ob-card__icon" aria-hidden="true">
                <Icon size="1.75rem" />
              </span>
              <span className="ob-card__text">
                <span className="ob-card__title">{c.title}</span>
                <span className="ob-card__desc">{c.description}</span>
              </span>
              <span className="ob-card__check" aria-hidden="true">
                {on && <icons.check />}
              </span>
              <span className="ob-card__dwell" aria-hidden="true" />
            </button>
          )
        })}
      </div>
      <section className="ob-preview" aria-labelledby="ob-preview-title" aria-live="polite">
        <h2 id="ob-preview-title" className="ob-label">
          What changes
        </h2>
        {preview.length ? (
          <ul>
            {preview.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          <p className="ui-hint">Nothing yet. Lumen keeps its standard settings.</p>
        )}
      </section>
    </div>
  )
}

// ---- 2. Key ----

export function KeyStep({
  cfg,
  patch,
  onReady
}: {
  cfg: Config
  patch: Patch
  onReady: (ready: boolean) => void
}): JSX.Element {
  const local = cfg.models.provider === 'local'
  const [hasKey, setHasKey] = useState(false)
  useEffect(() => onReady(hasKey || local), [hasKey, local, onReady])
  return (
    <div className="ob-stack">
      <p className="ob-lead">
        Lumen is free. To understand your screen it uses an AI service with your own key, so you pay
        that service directly, usually a few cents a day. One key is enough.
      </p>
      <KeyForm
        onReady={setHasKey}
        onSaved={() => {
          if (local) void patch({ models: { provider: 'auto' } })
        }}
      />

      <details className="ob-details">
        <summary>No key? Use a free model on this PC</summary>
        <p>
          If you run Ollama or LM Studio with a vision model, Lumen can use it instead. It’s free
          and private but slower and less accurate. This is experimental.
        </p>
        <div className="panel-row">
          <Button
            variant={local ? 'secondary' : 'quiet'}
            onClick={() => void patch({ models: { provider: local ? 'auto' : 'local' } })}
          >
            {local ? 'Stop using a local model' : 'Use a local model'}
          </Button>
          {local && <span className="ui-hint">Lumen will look for a local model.</span>}
        </div>
      </details>
    </div>
  )
}

// ---- 3. Voice ----

function useInstall(
  statusChannel: 'voice:stt-status' | 'wake:model-status',
  progressChannel: 'voice:stt-model-progress' | 'wake:model-progress'
): { progress: WakeModelProgress | null; done: boolean; unsupported: boolean } {
  const [progress, setProgress] = useState<WakeModelProgress | null>(null)
  const [done, setDone] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  useEffect(() => {
    let alive = true
    const off = window.lumen.on(progressChannel, (p) => {
      setProgress(p)
      if (p.phase === 'done') setDone(true)
    })
    const begin = async (): Promise<void> => {
      if (statusChannel === 'voice:stt-status') {
        const s: SttStatus = await invoke('voice:stt-status')
        if (!alive) return
        if (!s.localSupported) return setUnsupported(true)
        if (s.localInstalled) return setDone(true)
        if (s.installing) return setProgress({ phase: 'downloading', percent: s.percent ?? 0 })
        setProgress({ phase: 'downloading', percent: 0 })
        await invoke('voice:stt-install')
      } else {
        const s = await invoke('wake:model-status')
        if (!alive) return
        if (s.installed) return setDone(true)
        setProgress({ phase: 'downloading', percent: 0 })
        const r = await invoke('wake:model-install')
        if (alive && r.ok) setDone(true)
      }
    }
    begin().catch(() => {
      if (alive) setProgress({ phase: 'error', message: 'Download didn’t start.' })
    })
    return () => {
      alive = false
      off()
    }
  }, [statusChannel, progressChannel])
  return { progress, done, unsupported }
}

function InstallRow({
  label,
  state
}: {
  label: string
  state: ReturnType<typeof useInstall>
}): JSX.Element {
  const { progress, done, unsupported } = state
  if (done)
    return (
      <p className="panel-ok">
        <icons.checkCircle /> {label}: ready
      </p>
    )
  if (unsupported) return <p className="ui-hint">{label}: not available on this PC.</p>
  if (progress?.phase === 'error')
    return (
      <p className="panel-warn" role="status">
        <icons.alert /> {label}: {progress.message ?? 'download failed'}. You can retry in Settings
        → Voice.
      </p>
    )
  return (
    <ProgressBar
      label={progress?.phase === 'extracting' ? `${label}: unpacking` : `${label}: downloading`}
      value={progress?.phase === 'extracting' ? undefined : (progress?.percent ?? 0) / 100}
    />
  )
}

export function VoiceStep({ cfg, patch }: { cfg: Config; patch: Patch }): JSX.Element {
  const [devices, refreshDevices] = useMicDevices()
  const stt = useInstall('voice:stt-status', 'voice:stt-model-progress')
  const wake = useInstall('wake:model-status', 'wake:model-progress')
  const saved = cfg.voice.micDeviceId ?? ''
  return (
    <div className="ob-stack">
      <p className="ob-lead">
        Lumen understands speech on this PC, for free. It’s getting the voice files now (one time).
      </p>
      <div className="ob-stack ob-installs">
        <InstallRow label="Speech recognition" state={stt} />
        <InstallRow label="Wake word" state={wake} />
      </div>
      <Select
        label="Microphone"
        value={saved}
        options={micOptions(devices, saved)}
        onChange={(micDeviceId) => patch({ voice: { micDeviceId } })}
      />
      <p className="ui-hint">
        Press Test and say “Hello Lumen”. The bar moves when Lumen hears you.
      </p>
      <MicTest deviceId={saved} onOpened={refreshDevices} />
    </div>
  )
}

// ---- 4. Memory ----

export function MemoryStep({
  choice,
  onChoose
}: {
  choice: boolean | null
  onChoose: (yes: boolean) => void
}): JSX.Element {
  return (
    <div className="ob-stack">
      <p className="ob-lead">
        Should Lumen remember things about you, like how you use your PC, to help better? It stays
        on this PC and you can see, change or delete it any time.
      </p>
      <div className="ob-choices" role="group" aria-label="Remember things about you">
        <button
          type="button"
          data-choose
          className={`ob-card ob-card--short${choice === true ? ' is-on' : ''}`}
          aria-pressed={choice === true}
          onClick={() => onChoose(true)}
        >
          <span className="ob-card__icon" aria-hidden="true">
            <icons.brain size="1.5rem" />
          </span>
          <span className="ob-card__text">
            <span className="ob-card__title">Yes, remember (recommended)</span>
            <span className="ob-card__desc">Lumen asks before it saves anything new.</span>
          </span>
        </button>
        <button
          type="button"
          data-choose
          className={`ob-card ob-card--short${choice === false ? ' is-on' : ''}`}
          aria-pressed={choice === false}
          onClick={() => onChoose(false)}
        >
          <span className="ob-card__icon" aria-hidden="true">
            <icons.close size="1.5rem" />
          </span>
          <span className="ob-card__text">
            <span className="ob-card__title">Not now</span>
            <span className="ob-card__desc">You can turn it on later in Settings.</span>
          </span>
        </button>
      </div>
    </div>
  )
}

// ---- 5. Try ----

export function TryStep({ cfg }: { cfg: Config }): JSX.Element {
  const [text, setText] = useState('')
  const hint = talkHint({
    hotkey: cfg.hotkey,
    tap: cfg.handsFreeMode,
    wake: cfg.wakeWord.enabled ? cfg.wakeWord.phrase : null
  })
  return (
    <div className="ob-stack">
      <p className="ob-lead">{hint}: “What’s on my screen?”</p>
      <div className="ob-hotkey" aria-hidden="true">
        <Kbd combo={cfg.hotkey} />
      </div>
      <p className="ui-hint">The answer appears near the bottom of the screen.</p>
      <form
        className="panel-row panel-row--end"
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim()) send('home:run', text.trim())
        }}
      >
        <Field label="Or type a question">
          {(a) => (
            <input
              {...a}
              className="ui-input"
              value={text}
              maxLength={2000}
              placeholder="What’s on my screen?"
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" icon={icons.play} disabled={!text.trim()}>
          Ask
        </Button>
      </form>
    </div>
  )
}

// ---- 6. Done ----

export function DoneStep({ cfg, changes }: { cfg: Config; changes: string[] }): JSX.Element {
  return (
    <div className="ob-stack">
      {changes.length > 0 && (
        <section aria-labelledby="ob-summary" className="ob-preview">
          <h2 id="ob-summary" className="ob-label">
            Here’s what I set up
          </h2>
          <ul>
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="ob-lead">You can change these any time in Settings.</p>
      <div className="ob-reminder">
        <icons.mic />
        <span>
          To talk to Lumen, {cfg.handsFreeMode ? 'tap' : 'hold'} <Kbd combo={cfg.hotkey} />
          {cfg.wakeWord.enabled ? ` or say “${cfg.wakeWord.phrase}”` : ''}.
        </span>
      </div>
      <p className="ui-hint">Lumen lives in the tray, next to the clock. Click it for Home.</p>
    </div>
  )
}
