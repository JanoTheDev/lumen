// The keyword spotter matches sounds, not words: "stop" also fires inside "stopwatch" and
// "bus stop page". A cancel hit counts only when a transcript of the last seconds has the
// phrase as whole words at the end, or followed only by a filler like "that" or "please".

const TRAILING_OK = new Set(['that', 'it', 'this', 'now', 'please', 'everything', 'lumen', 'all'])

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

export function confirmsCancel(transcript: string, phrase: string): boolean {
  const said = words(transcript)
  const want = words(phrase)
  if (!want.length) return false
  for (let i = said.length - want.length; i >= 0; i--) {
    if (want.every((w, k) => said[i + k] === w)) {
      return said.slice(i + want.length).every((w) => TRAILING_OK.has(w))
    }
  }
  return false
}
