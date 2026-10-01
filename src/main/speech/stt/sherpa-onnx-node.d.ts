// Minimal typing for the parts of sherpa-onnx-node (Apache-2.0) that local STT uses.
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
}
