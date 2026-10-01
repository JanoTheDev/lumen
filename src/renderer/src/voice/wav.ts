// Turns a recording into 16 kHz mono 16-bit WAV: the format the local speech engine reads and
// the cloud one accepts. 32 KB per second, so a 10 minute dictation stays under 20 MB.
export const STT_SAMPLE_RATE = 16000

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buf)
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

/** Decodes a MediaRecorder blob and resamples it to 16 kHz mono WAV. */
export async function toSttWav(encoded: ArrayBuffer): Promise<ArrayBuffer> {
  const ctx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(encoded.slice(0))
  } finally {
    ctx.close().catch(() => {})
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * STT_SAMPLE_RATE))
  const offline = new OfflineAudioContext(1, frames, STT_SAMPLE_RATE)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return encodeWav(rendered.getChannelData(0), STT_SAMPLE_RATE)
}
