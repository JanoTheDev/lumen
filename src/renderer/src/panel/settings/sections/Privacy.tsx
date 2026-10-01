import { Card, Switch } from '../../../ui'
import type { SectionProps } from '../meta'

const FLOWS: Array<[string, string, string]> = [
  ['Your question', 'The AI provider you chose', 'Only when you ask something'],
  ['A screenshot of your screen', 'The AI provider you chose', 'Only when the question needs it'],
  ['Wake word audio', 'Nowhere, it stays on this PC', 'While the wake word is on'],
  ['Your recording', 'The speech service, to turn it into text', 'Only while you speak'],
  ['Settings and memory', 'Nowhere, they stay on this PC', 'Always local']
]

export function Privacy({ cfg, patch }: SectionProps): JSX.Element {
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
            {FLOWS.map(([what, where, when]) => (
              <tr key={what}>
                <th scope="row">{what}</th>
                <td>{where}</td>
                <td>{when}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
    </>
  )
}
