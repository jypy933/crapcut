// Sound descriptions whisper.cpp writes over game sound and music instead of
// words: "*Dramatic music*", "[BLANK_AUDIO]", "(upbeat music)", "♪ la la ♪".
// With `-ml 1 -sow` every word is its own segment, so a description arrives
// as several segments ("*Dramatic", "music*") and the one-segment check in
// `parseWhisperJson` misses it. Measured without VAD on real game audio:
// "*Dramatic music*" three times in a minute; with VAD on, none in 115,000
// real words, so this is a safety net, not a fix for a common case.

/** The character that closes each opener. */
const CLOSER: Record<string, string> = { '[': ']', '(': ')', '（': '）', '*': '*', '♪': '♪' }
/** Longest description swallowed; a bracket left open longer than this is left alone. */
const MAX_MARKER_ENTRIES = 8

const endsWith = (text: string, closer: string): boolean => text.replace(/[.,!?…]+$/, '').endsWith(closer)

/**
 * Which entries (segment texts, in order) are part of a sound description:
 * from one that opens a bracket, asterisk or note up to the next that closes
 * it the same way, at most `MAX_MARKER_ENTRIES` long. An entry with the
 * asterisks in the middle ("f***ing") does not open one, and an opener with no
 * closer nearby is left alone.
 */
export function soundMarkerMask(texts: string[]): boolean[] {
  const mask = texts.map(() => false)
  for (let i = 0; i < texts.length; i++) {
    const open = texts[i]!.trim()
    const closer = CLOSER[open[0] ?? '']
    if (!closer) continue
    // A one-piece marker ("[Music]", "*sigh*") is dropped by the caller already.
    if (open.length > 1 && endsWith(open, closer)) continue
    for (let j = i + 1; j < Math.min(texts.length, i + MAX_MARKER_ENTRIES); j++) {
      if (endsWith(texts[j]!.trim(), closer)) {
        for (let k = i; k <= j; k++) mask[k] = true
        i = j
        break
      }
    }
  }
  return mask
}
