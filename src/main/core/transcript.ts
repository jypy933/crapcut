// Transcript handling: splitting long audio into chunks at quiet moments,
// reading whisper.cpp's JSON output and cleaning up the word list.

import type { Range, Word } from '@shared/types'

/**
 * Splits [0, duration) into chunks of about `chunkSec`, moving each cut to the
 * quietest second within `searchSec` so words are not cut in half.
 */
export function planChunks(durationSec: number, loudness: Float64Array | null, chunkSec = 600, searchSec = 30): Range[] {
  if (durationSec <= 0) return []
  const cuts: number[] = []
  for (let nominal = chunkSec; nominal < durationSec - chunkSec / 4; nominal += chunkSec) {
    let best = nominal
    if (loudness && loudness.length > 0) {
      let bestDb = Infinity
      const lo = Math.max(1, Math.floor(nominal - searchSec))
      const hi = Math.min(loudness.length - 2, Math.ceil(nominal + searchSec))
      for (let s = lo; s <= hi; s++) {
        const db = loudness[s]!
        if (db < bestDb - 1e-9 || (Math.abs(db - bestDb) < 1e-9 && Math.abs(s - nominal) < Math.abs(best - nominal))) {
          bestDb = db
          best = s
        }
      }
    }
    const prev = cuts[cuts.length - 1] ?? 0
    if (best > prev + 1) cuts.push(best)
  }
  const out: Range[] = []
  let start = 0
  for (const c of cuts) {
    out.push({ start, end: c })
    start = c
  }
  out.push({ start, end: durationSec })
  return out
}

interface WhisperSegment {
  offsets?: { from?: number; to?: number }
  text?: string
}

/** Non-speech markers whisper sometimes emits, e.g. "[BLANK_AUDIO]", "(music)". */
const NON_SPEECH = /^[[(（*♪].*[\])）*♪]$|^♪+$/

/**
 * Reads whisper.cpp `-oj` output produced with `-ml 1 -sow` (one word per
 * segment). Offsets are milliseconds from the start of the audio file.
 */
export function parseWhisperJson(json: unknown): { language: string | null; words: Word[] } {
  const obj = (json ?? {}) as { result?: { language?: unknown }; transcription?: unknown }
  const language = typeof obj.result?.language === 'string' ? obj.result.language : null
  const segs = Array.isArray(obj.transcription) ? (obj.transcription as WhisperSegment[]) : []
  const words: Word[] = []
  for (const seg of segs) {
    if (!seg || typeof seg !== 'object') continue
    const raw = typeof seg.text === 'string' ? seg.text : ''
    const from = Number(seg.offsets?.from)
    const to = Number(seg.offsets?.to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    // Whisper marks speaker changes with a leading dash ("- Yeah").
    const text = raw.trim().replace(/^[-–—]+\s*/, '')
    if (!text || NON_SPEECH.test(text) || !/[\p{L}\p{N}]/u.test(text)) continue
    const t0 = from / 1000
    const t1 = Math.max(t0, to / 1000)
    const prev = words[words.length - 1]
    // A piece without a leading space continues the previous word ("don" + "'t").
    if (prev && !/^\s/.test(raw) && t0 - prev.t1 < 0.05) {
      prev.text += text
      prev.t1 = Math.max(prev.t1, t1)
      continue
    }
    words.push({ t0, t1, text })
  }
  return { language, words: tidyWords(words) }
}

/** Version of the per-chunk transcript files; chunks written by older versions are redone. */
export const CHUNK_FORMAT = 2

/**
 * Moves a chunk's words (timed from the start of the chunk's own WAV) onto
 * the VOD timeline and drops anything that falls outside the chunk.
 */
export function placeChunkWords(words: Word[], range: Range, slackSec = 1): { words: Word[]; dropped: number } {
  const out: Word[] = []
  for (const w of words) {
    const t0 = w.t0 + range.start
    if (t0 < range.start - slackSec || t0 > range.end + slackSec) continue
    out.push({ ...w, t0, t1: Math.min(w.t1 + range.start, range.end + slackSec) })
  }
  return { words: out, dropped: words.length - out.length }
}

/** Sorts words, removes overlaps and long hallucinated repeats. */
export function tidyWords(words: Word[]): Word[] {
  const sorted = words.map((w) => ({ ...w })).sort((a, b) => a.t0 - b.t0)
  for (let i = 0; i < sorted.length - 1; i++) {
    const w = sorted[i]!
    const next = sorted[i + 1]!
    if (w.t1 > next.t0) w.t1 = Math.max(w.t0, next.t0)
  }
  return dropRepeatedRuns(sorted)
}

/**
 * Whisper can loop on silence ("thanks thanks thanks ..."). A word repeated
 * more than 4 times in a row keeps only its first 2.
 */
function dropRepeatedRuns(words: Word[]): Word[] {
  const norms = words.map((w) => normalise(w.text))
  const out: Word[] = []
  let i = 0
  while (i < words.length) {
    let j = i + 1
    while (j < words.length && norms[j] === norms[i]) j++
    const runLength = j - i
    const keep = runLength > 4 ? 2 : runLength
    for (let k = i; k < i + keep; k++) out.push(words[k]!)
    i = j
  }
  return out
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** Merges per-chunk word lists, keeping each chunk's words inside its range. */
export function mergeChunks(chunks: { range: Range; words: Word[] }[]): Word[] {
  const all: Word[] = []
  for (const c of chunks) for (const w of c.words) if (w.t0 >= c.range.start - 0.5 && w.t0 < c.range.end) all.push(w)
  // Chunks are cut in quiet spots, but drop exact duplicates at the seams anyway.
  const sorted = all.sort((a, b) => a.t0 - b.t0)
  const unique = sorted.filter((w, i) => i === 0 || !(Math.abs(w.t0 - sorted[i - 1]!.t0) < 0.05 && w.text === sorted[i - 1]!.text))
  return tidyWords(unique)
}

/** Words overlapping [start, end). `words` must be sorted. */
export function wordsIn(words: Word[], start: number, end: number): Word[] {
  let lo = 0
  let hi = words.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (words[mid]!.t1 <= start) lo = mid + 1
    else hi = mid
  }
  const out: Word[] = []
  for (let i = lo; i < words.length && words[i]!.t0 < end; i++) out.push(words[i]!)
  return out
}

/** Compact on-disk form: [t0, t1, text] with millisecond precision. */
export type PackedWord = [number, number, string]

export function packWords(words: Word[]): PackedWord[] {
  return words.map((w) => [Math.round(w.t0 * 1000) / 1000, Math.round(w.t1 * 1000) / 1000, w.text])
}

export function unpackWords(packed: PackedWord[]): Word[] {
  return packed.map(([t0, t1, text]) => ({ t0, t1, text }))
}
