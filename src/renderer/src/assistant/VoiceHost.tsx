// Mount point for the voice module in the assistant window. Until the voice controller
// replaces it, this hosts the existing recorder (App), hidden: the bar draws the UI.
import LegacyVoice from '../App'

export function VoiceHost(): JSX.Element {
  return (
    <div hidden data-voice-host="">
      <LegacyVoice headless />
    </div>
  )
}
