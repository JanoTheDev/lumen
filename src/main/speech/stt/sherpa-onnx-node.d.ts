// Minimal typing for the parts of sherpa-onnx-node (Apache-2.0) that local STT and the
// wake-word spotter use.
declare module 'sherpa-onnx-node' {
  export interface OfflineStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
  }
  export interface OfflineRecognizer {
    createStream(): OfflineStream
    decodeAsync(stream: OfflineStream): Promise<{ text: string }>
  }
  export const OfflineRecognizer: {
    createAsync(config: Record<string, unknown>): Promise<OfflineRecognizer>
  }
  export interface OnlineStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
  }
  export class KeywordSpotter {
    constructor(config: Record<string, unknown>)
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    decode(stream: OnlineStream): void
    reset(stream: OnlineStream): void
    getResult(stream: OnlineStream): { keyword: string }
  }
}
