// Settings → About → Third-party licences: the components Lumen ships or downloads. Keep in
// step with build/third_party/NOTICES.txt (shipped as resources/third_party/NOTICES.txt).

export interface Notice {
  name: string
  licence: string
  /** What Lumen uses it for, and whether it ships or is downloaded. */
  use: string
  url: string
}

export const NOTICES: readonly Notice[] = [
  {
    name: 'Parakeet TDT-CTC 110M (NVIDIA)',
    licence: 'CC-BY-4.0',
    use: 'Speech recognition on this PC. Downloaded on first use; converted to ONNX int8 by sherpa-onnx.',
    url: 'https://huggingface.co/nvidia/parakeet-tdt_ctc-110m'
  },
  {
    name: 'Canary 180M Flash (NVIDIA)',
    licence: 'CC-BY-4.0',
    use: 'Speech recognition for Spanish, German and French. Downloaded only for those languages; converted to ONNX int8 by sherpa-onnx.',
    url: 'https://huggingface.co/nvidia/canary-180m-flash'
  },
  {
    name: 'sherpa-onnx and its wake-word model',
    licence: 'Apache-2.0',
    use: 'Runs speech recognition and the wake word. The wake-word model is downloaded on first use.',
    url: 'https://github.com/k2-fsa/sherpa-onnx'
  },
  {
    name: 'ONNX Runtime',
    licence: 'MIT',
    use: 'Runs the speech models. Ships with Lumen.',
    url: 'https://github.com/microsoft/onnxruntime'
  },
  {
    name: 'NVDA Controller Client',
    licence: 'LGPL-2.1',
    use: 'Speaks through the NVDA screen reader. Ships unmodified; you may replace or delete the DLL.',
    url: 'https://www.nvaccess.org/'
  },
  {
    name: 'Vosk small English model',
    licence: 'Apache-2.0',
    use: 'Wake-word fallback. Downloaded only when the fallback is used.',
    url: 'https://alphacephei.com/vosk/'
  },
  {
    name: 'MediaPipe Face Landmarker',
    licence: 'Apache-2.0',
    use: 'Face gestures. Downloaded only when face gestures are turned on.',
    url: 'https://github.com/google-ai-edge/mediapipe'
  },
  {
    name: 'Electron, Chromium and Node.js',
    licence: 'MIT and others',
    use: 'The app shell. Licences are next to Lumen.exe.',
    url: 'https://github.com/electron/electron'
  }
]

/** The licence's own page (CC licences need the link for attribution). */
export function licenceUrl(licence: string): string | undefined {
  if (licence === 'CC-BY-4.0') return 'https://creativecommons.org/licenses/by/4.0/'
  if (licence === 'LGPL-2.1') return 'https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html'
  if (licence === 'Apache-2.0') return 'https://www.apache.org/licenses/LICENSE-2.0'
  return undefined
}
