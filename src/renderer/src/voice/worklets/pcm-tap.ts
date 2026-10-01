// AudioWorklet: forwards mono input as Int16 blocks at the context rate (16 kHz), 100 ms by
// default (`processorOptions.blockMs` changes it).
// Loaded through `?worker&url` so it ships as its own same-origin file (CSP script-src 'self').

declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, ctor: unknown): void
declare const sampleRate: number

class PcmTap extends AudioWorkletProcessor {
  private readonly block: Int16Array
  private filled = 0

  constructor(options?: { processorOptions?: { blockMs?: number } }) {
    super()
    const ms = options?.processorOptions?.blockMs ?? 100
    this.block = new Int16Array(Math.max(1, Math.round((sampleRate * ms) / 1000)))
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]))
      this.block[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff
      if (this.filled === this.block.length) {
        const out = this.block.slice().buffer
        this.port.postMessage(out, [out])
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTap)
