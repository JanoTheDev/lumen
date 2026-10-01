// Reads the 16-bit PCM WAV the voice renderer records. Stereo is mixed down to mono.

export interface Pcm {
  samples: Float32Array
  sampleRate: number
}

function tag(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3)
  )
}

/** Returns null when `buf` is not a 16-bit PCM WAV. */
export function parseWav(buf: ArrayBuffer): Pcm | null {
  if (buf.byteLength < 44) return null
  const view = new DataView(buf)
  if (tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') return null
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let at = 12
  while (at + 8 <= buf.byteLength) {
    const id = tag(view, at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      if (view.getUint16(body, true) !== 1) return null
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      if (bits !== 16 || channels < 1 || !sampleRate) return null
      const end = Math.min(buf.byteLength, body + size)
      const frames = Math.floor((end - body) / (2 * channels))
      const samples = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += view.getInt16(body + (i * channels + c) * 2, true)
        samples[i] = sum / channels / 32768
      }
      return { samples, sampleRate }
    }
    at = body + size + (size & 1)
  }
  return null
}

export function isWav(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false
  const view = new DataView(buf)
  return tag(view, 0) === 'RIFF' && tag(view, 8) === 'WAVE'
}
