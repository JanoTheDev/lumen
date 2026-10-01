// First-run setup: profile, one AI key, voice files and mic, memory, a first question.
// Every step can be skipped and works with mouse, keyboard, dwell or a single switch.
import { useCallback, useEffect, useRef, useState } from 'react'
import { describeChanges, isProfileId, type ProfileId } from '@shared/profiles'
import { Button, Toast, announce, icons } from '../../ui'
import { invoke, send } from '../../lib/ipc'
import { useConfig } from '../settings/useConfig'
import {
  STEP_TITLES,
  accessFacts,
  buildSteps,
  nextStep,
  prevStep,
  stepLabel,
  type StepId
} from './flow'
import { PRESET_CARDS } from './presets'
import { speak, stopSpeaking, useAutoScan, useDwellChoose } from './inputs'
import { DoneStep, KeyStep, MemoryStep, ProfileStep, TryStep, VoiceStep } from './steps'
import { NumbersStep, PointStep } from './practice'

const INTRO: Record<StepId, string> = {
  profile: 'How do you want to use your computer with Lumen?',
  key: 'Connect an AI service',
  voice: 'Set up your voice',
  memory: 'Should Lumen remember things about you?',
  try: 'Ask your first question',
  point: 'Watch Lumen point',
  numbers: 'Click by number',
  lesson: 'A mini lesson',
  done: 'You’re all set'
}

const steps = buildSteps()

export function Onboarding(): JSX.Element {
  const { cfg, patch, error } = useConfig()
  const [step, setStep] = useState<StepId>(steps[0])
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')
  const [chosen, setChosen] = useState<ProfileId[] | null>(null)
  const [applied, setApplied] = useState<string[]>([])
  const [keyReady, setKeyReady] = useState(false)
  const [remember, setRemember] = useState<boolean | null>(null)
  const [screenReader, setScreenReader] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const first = useRef(true)

  // Re-running setup starts from the profiles picked last time.
  const picked: ProfileId[] = chosen ?? cfg?.a11y.profiles.filter(isProfileId) ?? []

  useEffect(() => {
    invoke('onboarding:info')
      .then((i) => setScreenReader(i.screenReader))
      .catch(() => setScreenReader(false))
  }, [])

  // The first screen reads itself aloud unless a screen reader already does.
  useEffect(() => {
    if (screenReader !== false || step !== 'profile') return
    speak(`${INTRO.profile} ${PRESET_CARDS.map((c) => c.title).join('. ')}.`)
    return stopSpeaking
  }, [screenReader, step])

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    heading.current?.focus()
  }, [step])

  // Dwell and switch scanning work on every step until the user clicks or presses Tab.
  useDwellChoose(root)
  useAutoScan(root, screenReader === false)

  const go = useCallback((to: StepId, d: 'fwd' | 'back') => {
    stopSpeaking()
    setDir(d)
    setStep(to)
    announce(stepLabel(steps, to))
  }, [])

  const finish = useCallback(async (): Promise<void> => {
    stopSpeaking()
    await patch({ onboarding: { done: true } })
    send('settings:window-close')
  }, [patch])

  const leaveStep = async (): Promise<void> => {
    if (!cfg) return
    if (step === 'profile') {
      setApplied(describeChanges(cfg, picked))
      await invoke('a11y:apply-profile', picked)
    }
    if (step === 'memory' && remember !== null) {
      if (remember) {
        await patch({ memory: { enabled: true, autoLearn: 'ask' } })
        for (const text of accessFacts(picked)) {
          await invoke('memory:fact', {
            op: 'add',
            layer: 'profile',
            section: 'Access needs',
            text
          }).catch(() => {})
        }
      } else if (cfg.memory.enabled) {
        await patch({ memory: { enabled: false } })
      }
    }
  }

  const onContinue = async (): Promise<void> => {
    if (step === 'done') return void finish()
    setBusy(true)
    try {
      await leaveStep()
    } finally {
      setBusy(false)
    }
    go(nextStep(steps, step), 'fwd')
  }

  const index = steps.indexOf(step)
  const continueLabel =
    step === 'done'
      ? 'Finish'
      : step === 'key' && !keyReady
        ? 'Skip for now'
        : (step === 'memory' && remember === null) || step === 'point' || step === 'numbers'
          ? 'Skip'
          : 'Continue'

  return (
    <div className="panel ob" ref={root}>
      <header className="panel-titlebar">
        <span className="panel-titlebar__title">Set up Lumen</span>
        <span className="panel-titlebar__controls">
          <button
            type="button"
            aria-label="Minimize"
            onClick={() => send('settings:window-minimize')}
          >
            <icons.minus />
          </button>
          <button
            type="button"
            aria-label="Close setup"
            className="is-close"
            onClick={() => void finish()}
          >
            <icons.close />
          </button>
        </span>
      </header>

      <main className="ob-main" aria-labelledby="ob-heading">
        <div className="ob-progress">
          <ol className="ob-dots" aria-hidden="true">
            {steps.map((s, i) => (
              <li
                key={s}
                className={i < index ? 'is-done' : i === index ? 'is-current' : undefined}
              />
            ))}
          </ol>
          <span className="ob-step-label">
            {stepLabel(steps, step)} · {STEP_TITLES[step]}
          </span>
        </div>

        <div key={step} className={`ob-page is-${dir}`}>
          <div className="ob-heading-row">
            <h1 id="ob-heading" ref={heading} tabIndex={-1}>
              {INTRO[step]}
            </h1>
            {screenReader === false && (
              <Button
                variant="quiet"
                icon={icons.volume}
                aria-label="Read aloud"
                onClick={() => speak(heading.current?.innerText ?? INTRO[step])}
              />
            )}
          </div>
          {error && <Toast kind="error">{error}</Toast>}
          {!cfg ? (
            <p className="ui-hint">Loading…</p>
          ) : step === 'profile' ? (
            <ProfileStep
              chosen={picked}
              onChange={setChosen}
              preview={describeChanges(cfg, picked)}
            />
          ) : step === 'key' ? (
            <KeyStep cfg={cfg} patch={patch} onReady={setKeyReady} />
          ) : step === 'voice' ? (
            <VoiceStep cfg={cfg} patch={patch} />
          ) : step === 'memory' ? (
            <MemoryStep choice={remember} onChoose={setRemember} />
          ) : step === 'try' ? (
            <TryStep cfg={cfg} />
          ) : step === 'point' ? (
            <PointStep cfg={cfg} />
          ) : step === 'numbers' ? (
            <NumbersStep cfg={cfg} patch={patch} />
          ) : (
            <DoneStep cfg={cfg} changes={applied} />
          )}
        </div>
      </main>

      <footer className="ob-footer">
        {index > 0 ? (
          <Button
            data-scan
            variant="quiet"
            icon={icons.arrowLeft}
            onClick={() => go(prevStep(steps, step), 'back')}
          >
            Back
          </Button>
        ) : (
          <Button data-scan variant="quiet" onClick={() => void finish()}>
            Skip setup
          </Button>
        )}
        <Button
          data-choose
          variant="primary"
          size="lg"
          busy={busy}
          disabled={busy || !cfg}
          onClick={() => void onContinue()}
        >
          {continueLabel}
        </Button>
      </footer>
    </div>
  )
}
