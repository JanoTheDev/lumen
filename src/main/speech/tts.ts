import { openaiClient } from '../ai/providers/openai'
import * as answer from '../windows/answer'

type TtsVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'

/** Strips markdown so the voice does not read "asterisk asterisk bold asterisk asterisk". */
export function toSpeakable(text: string): string {
  return text
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Synthesises `text` with cloud TTS and hands the audio to the answer card to play. */
export async function speakAnswer(text: string, voice: string): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[tts] OPENAI_API_KEY missing — skipping')
    return
  }
  const result = await openaiClient().audio.speech.create(
    {
      model: 'tts-1',
      voice: voice as TtsVoice,
      input: toSpeakable(text),
      response_format: 'mp3',
    },
    { timeout: 60000 }
  )
  const buf = Buffer.from(await result.arrayBuffer())
  answer.send('voice:tts-audio', { mime: 'audio/mpeg', data: buf.toString('base64') })
}
