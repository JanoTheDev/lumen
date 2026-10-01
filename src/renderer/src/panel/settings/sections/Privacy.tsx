import { useEffect, useState } from 'react'
import type { SttStatus } from '@shared/channels'
import { voicePrivacyRows, voiceFullyLocal, type VoicePrivacyInput } from '@shared/voice-privacy'
import { Card, Switch } from '../../../ui'
import type { SectionProps } from '../meta'
import { PrivacyActions } from './PrivacyActions'

const FLOWS: Array<[string, string, string]> = [
  ['Your question', 'The AI provider you chose', 'Only when you ask something'],
  ['A screenshot of your screen', 'The AI provider you chose', 'Only when the question needs it'],
  ['Settings and memory', 'Nowhere, they stay on this PC', 'Always local']
]

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

      <PrivacyActions cfg={cfg} patch={patch} />
    </>
  )
}
