import { useEffect, useState } from 'react'
import type { SttStatus, WakeModelProgress } from '@shared/channels'
import {
  Button,
  Card,
  NumberField,
  ProgressBar,
  Select,
  Slider,
  Switch,
  TextField,
  announce,
  icons
} from '../../../ui'
import { windowsVoices } from '../../../voice/speaker'
import type { SectionProps } from '../meta'

const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

function SpeechModel(): JSX.Element {
  const [status, setStatus] = useState<SttStatus | null>(null)
  const [progress, setProgress] = useState<WakeModelProgress | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      window.lumen
        .invoke('voice:stt-status')
        .then(setStatus)
        .catch(() => {})
    }
    refresh()
    return window.lumen.on('voice:stt-model-progress', (p) => {
      setProgress(p)
      if (p.phase === 'done') {
        announce('Offline speech recognition is ready')
        refresh()
      }
      if (p.phase === 'error') announce(`Download failed. ${p.message ?? ''}`, 'assertive')
    })
  }, [])

  if (!status) return <p className="ui-hint">Checking offline speech recognition…</p>
  const busy =
    progress?.phase === 'downloading' ||
    progress?.phase === 'extracting' ||
    (status.installing && progress?.phase !== 'error')
  if (busy) {
    return (
      <ProgressBar
        label={
          progress?.phase === 'extracting'
            ? 'Unpacking the speech model'
            : 'Downloading the speech model'
        }
        value={
          progress?.phase === 'extracting'
            ? undefined
            : (progress?.percent ?? status.percent ?? 0) / 100
        }
      />
    )
  }
  if (!status.localSupported) {
    return <p className="ui-hint">Offline recognition can’t run on this PC.</p>
  }
  if (status.localInstalled) {
    return (
      <p className="panel-ok">
        <icons.checkCircle /> Offline model installed
        {status.engine === 'cloud' ? ' (OpenAI is in use)' : ''}
      </p>
    )
  }
  return (
    <div className="panel-row">
      <Button
        variant="primary"
        onClick={() => {
          setProgress({ phase: 'downloading', percent: 0 })
          window.lumen.invoke('voice:stt-install').catch(() => {})
        }}
      >
        Download offline model ({status.modelSizeMb} MB)
      </Button>
      <span className="ui-hint">
        {progress?.phase === 'error'
          ? `Last try failed: ${progress.message ?? 'unknown error'}`
          : 'Free, one-time download.'}
      </span>
    </div>
  )
}

function useWindowsVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  useEffect(() => {
    windowsVoices()
      .then(setVoices)
      .catch(() => {})
  }, [])
  return voices
}

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
  const cloud = cfg.voice.tts === 'cloud'
  const winVoices = useWindowsVoices()
  const voiceOptions = cloud
    ? OPENAI_VOICES.map((v) => ({ value: v as string, label: v[0].toUpperCase() + v.slice(1) }))
    : winVoices.map((v) => ({ value: v.name, label: v.name.replace(/^Microsoft /, '') }))
  // A voice from the other engine (or none yet) shows the voice that will actually be used.
  const voiceValue = voiceOptions.some((o) => o.value === cfg.voice.ttsVoice)
    ? cfg.voice.ttsVoice
    : (voiceOptions[0]?.value ?? '')
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

      <Card
        title="Speech recognition"
        description="Turns what you say into text. On this PC it’s free and audio never leaves your computer."
      >
        <Select
          label="Recognise speech"
          value={cfg.voice.stt === 'local' ? 'local' : 'cloud-batch'}
          options={[
            { value: 'local', label: 'On this PC (free, private)' },
            { value: 'cloud-batch', label: 'OpenAI (needs an OpenAI key)' }
          ]}
          onChange={(stt) => patch({ voice: { stt } })}
          hint="Without an OpenAI key, Lumen always uses this PC."
        />
        <SpeechModel />
      </Card>

      <Card title="Read answers aloud">
        <Switch
          checked={speaking}
          onChange={(on) => patch({ voice: { tts: on ? 'windows' : 'off' } })}
          label="Speak answers"
          hint="Starts speaking while the answer is still being written."
        />
        <Select
          label="Voice engine"
          value={cloud ? 'cloud' : 'windows'}
          disabled={!speaking}
          options={[
            { value: 'windows', label: 'Windows voices (free, offline)' },
            { value: 'cloud', label: 'OpenAI voices (needs an OpenAI key)' }
          ]}
          onChange={(tts) =>
            patch({
              voice: { tts, ttsVoice: tts === 'cloud' ? 'alloy' : (winVoices[0]?.name ?? '') }
            })
          }
        />
        <Select
          label="Voice"
          value={voiceValue}
          disabled={!speaking || voiceOptions.length === 0}
          options={voiceOptions}
          onChange={(ttsVoice) => patch({ voice: { ttsVoice } })}
        />
        <Slider
          label="Speed"
          value={cfg.voice.ttsRate}
          min={0.5}
          max={2}
          step={0.1}
          disabled={!speaking}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(ttsRate) => patch({ voice: { ttsRate } })}
        />
        <div className="panel-row">
          <Button
            icon={icons.play}
            disabled={!speaking}
            onClick={() => {
              window.lumen
                .invoke('voice:speak', 'Hi, this is Lumen. This is how I sound.')
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
