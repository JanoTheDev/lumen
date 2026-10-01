// File names of the wake-word model. Pure so the speech worker can import it (kws-model.ts
// pulls in the main-process download and window code).
export const KWS_FILES = {
  encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
  joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  tokens: 'tokens.txt',
  pieces: 'bpe.model'
}
