// Optional cloud voice (OpenAI). Only used when the user picked it and has an OpenAI key.
import { openaiClient } from '../../ai/providers/openai'

export const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const
type OpenAiVoice = (typeof OPENAI_VOICES)[number]

export function openAiTtsAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY
}

/** Returns base64 mp3 for one sentence. */
export async function synthOpenAi(text: string, voice: string, rate: number): Promise<string> {
  const v = (OPENAI_VOICES as readonly string[]).includes(voice) ? (voice as OpenAiVoice) : 'alloy'
  const res = await openaiClient().audio.speech.create(
    {
      model: 'tts-1',
      voice: v,
      input: text,
      response_format: 'mp3',
      speed: Math.max(0.25, Math.min(4, rate))
    },
    { timeout: 30000 }
  )
  return Buffer.from(await res.arrayBuffer()).toString('base64')
}
