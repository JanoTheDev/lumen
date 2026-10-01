import { toFile } from 'openai'
import { openaiClient } from '../ai/providers/openai'
import { loadConfig } from '../config'

// Whisper hallucinates on < ~0.5s of audio.
const MIN_AUDIO_BYTES = 6000

export function whisperPrompt(userVocab: string): string {
  const vocab = userVocab.trim()
  const vocabList = vocab
    ? `, ${vocab
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ')}`
    : ''
  return `AI assistant voice command. User speaks English. Common words: open, click, email, Gmail, drafts, inbox, reply, compose, send, navigate, GitHub, Lumen, Claude, Anthropic${vocabList}.`
}

// Whisper reads the prompt as preceding text: a punctuated sample nudges it to punctuate,
// and listed names nudge their spelling. Kept well under its 224-token prompt window.
const MAX_PROMPT_TERMS = 60

export function dictationPrompt(dictionary: readonly string[], userVocab = ''): string {
  const extra = userVocab
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const terms = [...new Set([...dictionary.map((d) => d.trim()), ...extra])]
    .filter(Boolean)
    .slice(0, MAX_PROMPT_TERMS)
  const names = terms.length ? ` Names and terms: ${terms.join(', ')}.` : ''
  return `Dictated text, written out with normal punctuation and capital letters.${names}`
}

export async function transcribe(
  audio: ArrayBuffer,
  opts: { dictation?: boolean } = {}
): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('Whisper requires OPENAI_API_KEY')

  if (audio.byteLength < MIN_AUDIO_BYTES) {
    console.log('[transcribe] audio too short (', audio.byteLength, 'bytes), skipping')
    return ''
  }

  const result = await openaiClient().audio.transcriptions.create(
    {
      // Sent from memory; recordings never touch disk.
      file: await toFile(Buffer.from(audio), 'recording.webm', { type: 'audio/webm' }),
      model: 'whisper-1',
      language: 'en',
      prompt: opts.dictation
        ? dictationPrompt(loadConfig().dictation.dictionary, loadConfig().voiceVocab)
        : whisperPrompt(loadConfig().voiceVocab)
    },
    { timeout: 60000 }
  )
  console.log('[transcribe] result:', result.text)
  const estSecs = audio.byteLength / 6000
  const whisperCost = (estSecs / 60) * 0.006
  console.log(`[tokens] whisper | ~${estSecs.toFixed(1)}s audio | $${whisperCost.toFixed(5)}`)
  return result.text
}
