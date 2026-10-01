// Where voice data goes for the engines in use, for Settings → Privacy. Pure; the rows follow
// the config and the speech engine main reports (voice:stt-status).

export interface VoicePrivacyInput {
  /** The engine transcribing now (null = none ready yet). */
  sttEngine: 'local' | 'cloud' | null
  tts: 'cloud' | 'windows' | 'off'
  wakeWord: boolean
  bargeIn: boolean
  cancelVoice: boolean
  dictation: { enabled: boolean; cleanup: 'light' | 'off' }
}

export interface PrivacyRow {
  what: string
  where: string
  when: string
  /** Nothing leaves this PC for this row. */
  local: boolean
}

export function voicePrivacyRows(v: VoicePrivacyInput): PrivacyRow[] {
  const rows: PrivacyRow[] = []
  rows.push(
    v.sttEngine === 'cloud'
      ? {
          what: 'Your recording',
          where: 'OpenAI, to turn it into text. Sent from memory, never saved by Lumen',
          when: 'Only while you speak',
          local: false
        }
      : {
          what: 'Your recording',
          where: 'Nowhere, the offline model on this PC turns it into text',
          when: 'Only while you speak',
          local: true
        }
  )
  if (v.wakeWord)
    rows.push({
      what: 'Wake word listening',
      where: 'Nowhere, the keyword spotter runs on this PC',
      when: 'While the wake word is on',
      local: true
    })
  if (v.cancelVoice)
    rows.push({
      what: 'Stop phrases',
      where: 'Nowhere, checked on this PC',
      when: 'While Lumen is working',
      local: true
    })
  if (v.bargeIn && v.tts !== 'off')
    rows.push({
      what: 'Talking over an answer',
      where: 'Nowhere, detected on this PC',
      when: 'While Lumen speaks',
      local: true
    })
  if (v.tts === 'cloud')
    rows.push({
      what: 'Spoken answers',
      where: 'The answer text goes to OpenAI to make the voice',
      when: 'For each spoken answer',
      local: false
    })
  else if (v.tts === 'windows')
    rows.push({
      what: 'Spoken answers',
      where: 'Nowhere, Windows voices on this PC',
      when: 'For each spoken answer',
      local: true
    })
  if (v.dictation.enabled)
    rows.push(
      v.dictation.cleanup === 'light'
        ? {
            what: 'Dictated text',
            where: 'The AI provider you chose, to fix punctuation (text only)',
            when: 'Each time you dictate',
            local: false
          }
        : {
            what: 'Dictated text',
            where: 'Nowhere, typed as heard',
            when: 'Each time you dictate',
            local: true
          }
    )
  rows.push({
    what: 'Audio files',
    where: 'None. Recordings stay in memory and are never written to disk',
    when: 'Always',
    local: true
  })
  return rows
}

/** True when no voice data leaves this PC with these settings. */
export function voiceFullyLocal(v: VoicePrivacyInput): boolean {
  return voicePrivacyRows(v).every((r) => r.local)
}
