import { useEffect, useState } from 'react'
import type { SttStatus } from '@shared/channels'
import { voicePrivacyRows, voiceFullyLocal, type VoicePrivacyInput } from '@shared/voice-privacy'
import { Card, SegmentedControl, Switch } from '../../../ui'
import type { SectionProps } from '../meta'
import { PrivacyActions } from './PrivacyActions'

const FLOWS: Array<[string, string, string]> = [
  ['Your question', 'The AI provider you chose', 'Only when you ask something'],
  ['A screenshot of your screen', 'The AI provider you chose', 'Only when the question needs it'],
  ['Settings and memory', 'Nowhere, they stay on this PC', 'Always local'],
  [
    'App name and task, for how-to lookups',
    'Microsoft Learn; your AI provider’s web search only when paid web search is on',
    'When Lumen does not know how something works in an app'
  ]
]

const HOWTO_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'free-only', label: 'Free only' },
  { value: 'off', label: 'Off' }
] as const

/** The speech engine main uses now (local, cloud or none yet). */
function useSttEngine(): SttStatus['engine'] | undefined {
  const [engine, setEngine] = useState<SttStatus['engine'] | undefined>(undefined)
  useEffect(() => {
    window.lumen
      .invoke('voice:stt-status')
      .then((s) => setEngine(s.engine))
      .catch(() => {})
  }, [])
  return engine
}

export function Privacy({ cfg, patch }: SectionProps): JSX.Element {
  const engine = useSttEngine()
  const voice: VoicePrivacyInput = {
    sttEngine: engine === undefined ? (cfg.voice.stt === 'local' ? 'local' : 'cloud') : engine,
    tts: cfg.voice.tts,
    wakeWord: cfg.wakeWord.enabled,
    bargeIn: cfg.voice.bargeIn,
    cancelVoice: cfg.cancelVoice.enabled,
    dictation: { enabled: cfg.dictation.enabled, cleanup: cfg.dictation.cleanup }
  }
  const rows: Array<[string, string, string]> = [
    ...FLOWS.slice(0, 2),
    ...voicePrivacyRows(voice).map((r): [string, string, string] => [r.what, r.where, r.when]),
    ...FLOWS.slice(2)
  ]
  return (
    <>
      <Card title="What is sent where">
        <table className="panel-table">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Goes to</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([what, where, when]) => (
              <tr key={what}>
                <th scope="row">{what}</th>
                <td>{where}</td>
                <td>{when}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="ui-hint">
          {voiceFullyLocal(voice)
            ? 'With these settings, no audio or voice text leaves this PC.'
            : 'Speech recognition on this PC and Windows voices keep all audio on this PC (Settings, Voice).'}
        </p>
      </Card>

      <Card title="On this PC">
        <Switch
          checked={cfg.privacy.saveScreenshots}
          onChange={(saveScreenshots) => patch({ privacy: { saveScreenshots } })}
          label="Keep screenshots on disk"
          hint="Off by default. Useful only for troubleshooting."
        />
        <Switch
          checked={cfg.privacy.telemetry}
          onChange={(telemetry) => patch({ privacy: { telemetry } })}
          label="Share anonymous usage data"
          hint="Off by default. Nothing is sent while this is off."
        />
      </Card>

      <Card
        title="How-to lookups"
        description="In apps Lumen has no guide for, it looks up how to do the task and then finds those menus and buttons on your screen. What worked is kept per app on this PC (app-notes) while memory is on."
      >
        <SegmentedControl
          label="Look up how-to steps"
          value={cfg.agent.howtoLookup}
          options={HOWTO_OPTIONS}
          onChange={(howtoLookup) => patch({ agent: { howtoLookup } })}
          hint="Auto: saved app notes, free official docs, then a web search on your AI key only if paid web search is on (Settings, News & reading; about $0.01 a search, at most 2 a task and 10 a day). Free only: never a paid search. Off: no lookups."
        />
      </Card>

      <PrivacyActions cfg={cfg} patch={patch} />
    </>
  )
}
