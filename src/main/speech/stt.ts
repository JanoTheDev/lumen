import { toFile } from 'openai'
import { openaiClient } from '../ai/providers/openai'
import { loadConfig } from '../config'

// Whisper hallucinates on < ~0.5s of audio.
const MIN_AUDIO_BYTES = 6000

export function whisperPrompt(userVocab: string): string {
  const vocab = userVocab.trim()
  const vocabList = vocab
    ? `, ${vocab.split(/[,\n]/).map(s => s.trim()).filter(Boolean).join(', ')}`
    : ''
  return `AI assistant voice command. User speaks English. Common words: open, click, email, Gmail, drafts, inbox, reply, compose, send, navigate, GitHub, Lumen, Claude, Anthropic${vocabList}.`
}

export async function transcribe(audio: ArrayBuffer): Promise<string> {
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
      prompt: whisperPrompt(loadConfig().voiceVocab),
    },
    { timeout: 60000 }
  )
  console.log('[transcribe] result:', result.text)
  const estSecs = audio.byteLength / 6000
  const whisperCost = (estSecs / 60) * 0.006
  console.log(`[tokens] whisper | ~${estSecs.toFixed(1)}s audio | $${whisperCost.toFixed(5)}`)
  return result.text
}
