import { useCallback, useEffect, useState } from 'react'
import type { SttStatus, WakeModelProgress, WakeStatus } from '@shared/channels'
import { WAKE_SENSITIVITY_DEFAULT } from '@shared/config'
import {
  Button,
  Card,
  NumberField,
  ProgressBar,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  TextField,
  announce,
  icons,
  type SliderProps
} from '../../../ui'
import { useDraft } from '../../../ui/draft'
import { windowsVoices } from '../../../voice/speaker'
import type { SectionProps } from '../meta'
import {
  PAUSE_OPTIONS,
  PAUSE_PRESETS,
  micOptions,
  pausePresetOf,
  sensitivityText
} from './voice-options'
import { LANGUAGE_OPTIONS, dictionaryFromText, languageHint } from './voice-language'
import { MicTest } from './MicTest'
import { useMicDevices } from './use-mic-devices'

const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

/** A slider that saves after a short pause instead of on every step. */
function DraftSlider({
  value,
  onCommit,
  ...rest
}: Omit<SliderProps, 'onChange'> & { onCommit: (v: number) => void }): JSX.Element {
  const draft = useDraft(value, onCommit)
  return <Slider {...rest} value={draft.value} onChange={draft.onChange} />
}

// ---- Microphone ----

function Microphone({ cfg, patch }: SectionProps): JSX.Element {
  const [devices, refreshDevices] = useMicDevices()
  const saved = cfg.voice.micDeviceId ?? ''
  const named = devices.some((d) => d.kind === 'audioinput' && d.label)
  return (
    <Card
      title="Microphone"
      description="Which microphone Lumen listens to, and how you start talking."
    >
      <Select
        label="Microphone"
        value={saved}
        options={micOptions(devices, saved)}
        onChange={(micDeviceId) => patch({ voice: { micDeviceId } })}
        hint={named ? undefined : 'Test the microphone once to see device names.'}
      />
      <MicTest deviceId={saved} onOpened={refreshDevices} />
      <SegmentedControl
        label="Start talking by"
        value={cfg.handsFreeMode ? 'tap' : 'hold'}
        options={[
          { value: 'hold', label: 'Holding the shortcut' },
          { value: 'tap', label: 'Tapping the shortcut' }
        ]}
        onChange={(mode) => patch({ handsFreeMode: mode === 'tap' })}
      />
      <p className="ui-hint">
        {cfg.handsFreeMode
          ? 'Tap once and speak; Lumen stops after a pause. Tap again to send early.'
          : 'Hold while you speak and let go to send. A quick tap also works and stops after a pause.'}
      </p>
      <Switch
        checked={cfg.voice.conversation}
        onChange={(conversation) => patch({ voice: { conversation } })}
        label="Double-tap for a conversation"
        hint="Double-tap the shortcut and keep talking: Lumen listens again after each answer. Double-tap again, press Escape or say “stop” to end. Ends by itself after 5 minutes without a request."
      />
    </Card>
  )
}

// ---- Wake word ----

function useWakeStatus(): [WakeStatus | null, () => void] {
  const [status, setStatus] = useState<WakeStatus | null>(null)
  const refresh = useCallback((): void => {
    window.lumen
      .invoke('wake:model-status')
      .then(setStatus)
      .catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
    return window.lumen.on('wake:status', setStatus)
  }, [refresh])
  return [status, refresh]
}

const ENGINE_TEXT: Record<WakeStatus['engine'], string> = {
  kws: 'Listening with the offline keyword spotter.',
  off: 'Not listening.'
}

function WakeEngine({
  status,
  refresh
}: {
  status: WakeStatus | null
  refresh: () => void
}): JSX.Element {
  const [progress, setProgress] = useState<WakeModelProgress | null>(null)

  useEffect(
    () =>
      window.lumen.on('wake:model-progress', (p) => {
        setProgress(p)
        if (p.phase === 'done') {
          announce('Wake word model installed')
          refresh()
        }
        if (p.phase === 'error') announce(`Install failed. ${p.message ?? ''}`, 'assertive')
      }),
    [refresh]
  )

  if (!status) return <p className="ui-hint">Checking the offline model…</p>
  if (status.unavailable) {
    return (
      <p className="panel-warn" role="status">
        <icons.alert /> Wake word unavailable. {status.unavailable}
      </p>
    )
  }
  if (progress?.phase === 'downloading' || progress?.phase === 'extracting') {
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
  return (
    <>
      {status.installed ? (
        <p className="panel-ok">
          <icons.checkCircle /> Offline model installed. {ENGINE_TEXT[status.engine]}
        </p>
      ) : (
        <div className="panel-row">
          <Button
            variant="primary"
            onClick={() => {
              setProgress({ phase: 'downloading', percent: 0 })
              window.lumen
                .invoke('wake:model-install')
                .then(refresh)
                .catch(() => {})
            }}
          >
            Install offline model ({status.sizeMb} MB)
          </Button>
          <span className="ui-hint">
            {progress?.phase === 'error'
              ? `Last try failed: ${progress.message ?? 'unknown error'}`
              : 'Free, one-time download.'}
          </span>
        </div>
      )}
      {status.unusable.length > 0 && (
        <p className="panel-warn" role="status">
          <icons.alert /> Lumen can’t listen for {status.unusable.map((p) => `“${p}”`).join(', ')}.
          Try other words.
        </p>
      )}
    </>
  )
}

function WakeWord({ cfg, patch }: SectionProps): JSX.Element {
  const [status, refresh] = useWakeStatus()
  return (
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
        hint="“Hey Lumen” is the most reliable; other phrases miss more often. Saved when you leave the field."
      />
      <DraftSlider
        label="Sensitivity"
        value={cfg.wakeWord.sensitivity ?? WAKE_SENSITIVITY_DEFAULT}
        min={0}
        max={1}
        step={0.1}
        format={sensitivityText}
        disabled={!cfg.wakeWord.enabled}
        onCommit={(sensitivity) => patch({ wakeWord: { sensitivity } })}
        hint="Raise it if Lumen misses you; lower it if Lumen wakes up by itself."
      />
      <WakeEngine status={status} refresh={refresh} />
    </Card>
  )
}

// ---- Silence detection ----

function SilenceDetection({ cfg, patch }: SectionProps): JSX.Element {
  const preset = pausePresetOf(cfg.vad.silenceMs)
  const [advanced, setAdvanced] = useState(preset === null)
  return (
    <Card
      title="Silence detection"
      description="When tap-to-talk and the wake word decide you’re done."
    >
      <SegmentedControl
        label="Pause before stopping"
        value={preset ?? 'normal'}
        options={PAUSE_OPTIONS}
        onChange={(p) => patch({ vad: { silenceMs: PAUSE_PRESETS[p] } })}
      />
      {preset === null && (
        <p className="ui-hint">Using a custom pause of {cfg.vad.silenceMs} ms.</p>
      )}
      <Switch checked={advanced} onChange={setAdvanced} label="Show advanced options" />
      {advanced && (
        <>
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
        </>
      )}
    </Card>
  )
}

// ---- Speech recognition ----

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

/** True while a screen reader runs (checked once when the section opens). */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    window.lumen
      .invoke('onboarding:info')
      .then((info) => setOn(info.screenReader))
      .catch(() => {})
  }, [])
  return on
}

export function Voice({ cfg, patch }: SectionProps): JSX.Element {
  const speaking = cfg.voice.tts !== 'off'
  const cloud = cfg.voice.tts === 'cloud'
  const winVoices = useWindowsVoices()
  const screenReader = useScreenReader()
  const voiceOptions = cloud
    ? OPENAI_VOICES.map((v) => ({ value: v as string, label: v[0].toUpperCase() + v.slice(1) }))
    : winVoices.map((v) => ({ value: v.name, label: v.name.replace(/^Microsoft /, '') }))
  // A voice from the other engine (or none yet) shows the voice that will actually be used.
  const voiceValue = voiceOptions.some((o) => o.value === cfg.voice.ttsVoice)
    ? cfg.voice.ttsVoice
    : (voiceOptions[0]?.value ?? '')
  return (
    <>
      <Microphone cfg={cfg} patch={patch} />
      <WakeWord cfg={cfg} patch={patch} />

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
        <TextField
          label="Personal dictionary"
          multiline
          value={cfg.dictation.dictionary.join(', ')}
          onCommit={(text) => patch({ dictation: { dictionary: dictionaryFromText(text) } })}
          commitOnBlurOnly
          hint="Spellings dictation always uses. Lumen adds a name here when you correct it the same way twice; remove it to undo."
        />
      </Card>

      <SilenceDetection cfg={cfg} patch={patch} />

      <Card
        title="Speech recognition"
        description="Turns what you say into text. On this PC it’s free and audio never leaves your computer."
      >
        <Select
          label="Language you speak"
          value={cfg.voice.language}
          options={LANGUAGE_OPTIONS}
          onChange={(language) => patch({ voice: { language } })}
          hint={languageHint(cfg.voice.language)}
        />
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
        <DraftSlider
          label="Speed"
          value={cfg.voice.ttsRate}
          min={0.5}
          max={2}
          step={0.1}
          disabled={!speaking}
          format={(v) => `${v.toFixed(1)}×`}
          onCommit={(ttsRate) => patch({ voice: { ttsRate } })}
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
        <Switch
          checked={cfg.voice.bargeIn}
          disabled={!speaking}
          onChange={(bargeIn) => patch({ voice: { bargeIn } })}
          label="Stop talking when I talk"
          hint="Speak over an answer to interrupt it and ask something new. The microphone is on while Lumen speaks. Use headphones for barge-in if Lumen interrupts itself."
        />
        <Switch
          checked={cfg.voice.copyWhenMuted}
          disabled={!speaking}
          onChange={(copyWhenMuted) => patch({ voice: { copyWhenMuted } })}
          label="Copy the answer when sound is muted"
          hint="When your sound is muted, Lumen shows the answer with an Unmute button instead of speaking."
        />
        <Switch
          checked={cfg.voice.ttsWithScreenReader}
          disabled={!speaking}
          onChange={(ttsWithScreenReader) => patch({ voice: { ttsWithScreenReader } })}
          label="Speak even when a screen reader is running"
          hint={
            (screenReader ? 'A screen reader is running now. ' : '') +
            'When this is off, answers go to your screen reader so you don’t hear two voices at once.'
          }
        />
      </Card>
    </>
  )
}
