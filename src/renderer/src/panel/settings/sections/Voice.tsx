import { useEffect, useState } from 'react'
import type { WakeModelProgress } from '@shared/channels'
import {
  Button,
  Card,
  NumberField,
  ProgressBar,
  Select,
  Switch,
  TextField,
  announce,
  icons
} from '../../../ui'
import type { SectionProps } from '../meta'

const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

function WakeModel(): JSX.Element {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [progress, setProgress] = useState<WakeModelProgress | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      window.lumen
        .invoke('wake:model-status')
        .then((s) => setInstalled(s.installed))
        .catch(() => setInstalled(false))
    }
    refresh()
    return window.lumen.on('wake:model-progress', (p) => {
      setProgress(p)
      if (p.phase === 'done') {
        announce('Wake word model installed')
        refresh()
      }
      if (p.phase === 'error') announce(`Install failed. ${p.message ?? ''}`, 'assertive')
    })
  }, [])

  const busy = progress?.phase === 'downloading' || progress?.phase === 'extracting'
  if (installed === null) return <p className="ui-hint">Checking the offline model…</p>
  if (busy) {
    return (
      <ProgressBar
        label={
          progress.phase === 'extracting'
            ? 'Unpacking the offline model'
            : 'Downloading the offline model'
        }
        value={progress.phase === 'extracting' ? undefined : (progress.percent ?? 0) / 100}
      />
    )
  }
  if (installed) {
    return (
      <p className="panel-ok">
        <icons.checkCircle /> Offline model installed
      </p>
    )
  }
  return (
    <div className="panel-row">
      <Button
        variant="primary"
        onClick={() => {
          setProgress({ phase: 'downloading', percent: 0 })
          window.lumen.invoke('wake:model-install').catch(() => {})
        }}
      >
        Install offline model (40 MB)
      </Button>
      <span className="ui-hint">
        {progress?.phase === 'error'
          ? `Last try failed: ${progress.message ?? 'unknown error'}`
          : 'Free, one-time download.'}
      </span>
    </div>
  )
}

export function Voice({ cfg, patch }: SectionProps): JSX.Element {
  const speaking = cfg.voice.tts !== 'off'
  return (
    <>
      <Card
        title="Wake word"
        description="Say a phrase to start Lumen without a shortcut. Runs offline."
      >
        <Switch
          checked={cfg.wakeWord.enabled}
          onChange={(enabled) => patch({ wakeWord: { enabled } })}
          label="Listen for the wake word"
        />
        <TextField
          label="Wake phrase"
          value={cfg.wakeWord.phrase}
          onCommit={(phrase) => patch({ wakeWord: { phrase } })}
          accept={(v) => v.trim().length > 0}
          commitOnBlurOnly
          hint="Short and unusual works best. Saved when you leave the field."
        />
        <WakeModel />
      </Card>

      <Card title="Stop by voice" description="Say a phrase to stop what Lumen is doing.">
        <Switch
          checked={cfg.cancelVoice.enabled}
          onChange={(enabled) => patch({ cancelVoice: { enabled } })}
          label="Listen for stop phrases"
          hint="Keeps the microphone on while Lumen is working."
        />
        <TextField
          label="Stop phrases"
          value={cfg.cancelVoice.phrases}
          onCommit={(phrases) => patch({ cancelVoice: { phrases } })}
          commitOnBlurOnly
          hint="Separate with commas."
        />
      </Card>

      <Card title="Words to recognise" description="Names and terms Lumen should expect to hear.">
        <TextField
          label="Vocabulary"
          multiline
          value={cfg.voiceVocab}
          onCommit={(voiceVocab) => patch({ voiceVocab })}
          hint="Separate with commas or new lines, for example: Kubernetes, DaVinci Resolve."
        />
      </Card>

      <Card
        title="Silence detection"
        description="When tap-to-talk and the wake word decide you’re done."
      >
        <NumberField
          label="Silence before stopping"
          value={cfg.vad.silenceMs}
          min={400}
          max={5000}
          step={100}
          unit="ms"
          onCommit={(silenceMs) => patch({ vad: { silenceMs } })}
        />
        <NumberField
          label="Wait for speech"
          value={cfg.vad.maxWaitMs}
          min={2000}
          max={20000}
          step={500}
          unit="ms"
          hint="Cancel if nothing is said in this time."
          onCommit={(maxWaitMs) => patch({ vad: { maxWaitMs } })}
        />
        <NumberField
          label="Speech threshold"
          value={Math.round(cfg.vad.speechThreshold * 100)}
          min={1}
          max={20}
          unit="%"
          hint="Lower picks up quieter speech."
          onCommit={(v) => patch({ vad: { speechThreshold: v / 100 } })}
        />
      </Card>

      <Card title="Read answers aloud">
        <Switch
          checked={speaking}
          onChange={(on) => patch({ voice: { tts: on ? 'cloud' : 'off' } })}
          label="Speak answers"
          hint="Uses an OpenAI voice and needs an OpenAI key."
        />
        <Select
          label="Voice"
          value={cfg.voice.ttsVoice}
          disabled={!speaking}
          options={OPENAI_VOICES.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))}
          onChange={(ttsVoice) => patch({ voice: { ttsVoice } })}
        />
        <div className="panel-row">
          <Button
            icon={icons.play}
            disabled={!speaking}
            onClick={() => {
              window.lumen
                .invoke('voice:speak', 'Hi, this is Lumen.')
                .then((r) => {
                  if (!r.ok) announce(r.error ?? 'Couldn’t play the preview.', 'assertive')
                })
                .catch(() => {})
            }}
          >
            Preview voice
          </Button>
        </div>
      </Card>
    </>
  )
}
