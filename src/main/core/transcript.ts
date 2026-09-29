// Transcript handling: splitting long audio into chunks at quiet moments,
// reading whisper.cpp's JSON output (with DTW word times when present) and
// cleaning up the word list.

import type { Range, Word } from '@shared/types'
import { DEFAULT_WORD_TIMING, isStretchedWord, maxPlausibleDuration, type WordTimingOptions } from '@shared/wordTiming'
import { locateWordEnergy } from './align'

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

interface WhisperToken {
  text?: string
  t_dtw?: number
}

interface WhisperSegment {
  offsets?: { from?: number; to?: number }
  text?: string
  /** Only in `-ojf` output. */
  tokens?: WhisperToken[]
}

/** Non-speech markers whisper sometimes emits, e.g. "[BLANK_AUDIO]", "(music)". */
const NON_SPEECH = /^[[(（*♪].*[\])）*♪]$|^♪+$/

/**
 * One stretch of speech that whisper.cpp's VAD kept, in seconds: where it is
 * in the audio file, and where it starts in the speech-only audio whisper
 * actually heard (the stretches back to back).
 */
export interface VadSpan {
  start: number
  end: number
  vadStart: number
}

/**
 * Reads the `vad_segment_info` lines whisper.cpp logs when `--vad` is on, e.g.
 * "whisper_vad: vad_segment_info: orig_start: 2.40, orig_end: 2.81, vad_start: 0.00, vad_end: 0.41".
 */
export function parseVadSpans(lines: string[]): VadSpan[] {
  const out: VadSpan[] = []
  for (const line of lines) {
    const m = /orig_start:\s*([\d.]+),\s*orig_end:\s*([\d.]+),\s*vad_start:\s*([\d.]+)/.exec(line)
    if (!m) continue
    const [start, end, vadStart] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if ([start, end, vadStart].every(Number.isFinite) && end >= start) out.push({ start, end, vadStart })
  }
  return out.sort((a, b) => a.vadStart - b.vadStart)
}

/**
 * How late whisper.cpp's DTW token times are against the voice. Measured on
 * speech with exactly known word times, for both pinned models: a steady
 * ~200 ms, with little spread around it.
 */
export const DTW_LAG_SEC = 0.2

/** whisper.cpp keeps this much audio after each VAD stretch; a word's DTW time may fall into it. */
const VAD_TAIL_SEC = 0.1

/**
 * VAD only closes a stretch after about 100 ms of silence, so the voice has
 * stopped roughly this long before the end whisper reports. The last word
 * before a pause ends this much earlier: on speech with exactly known word
 * times, ends before pauses were ~180 ms late and are now within ~100 ms, and
 * on real streams the trimmed 100 ms was silent in about 96% of words.
 */
const VAD_END_TRIM_SEC = 0.1

/** A word is never cut shorter than this by the end of its VAD stretch. */
const MIN_SPAN_WORD_SEC = 0.1

/** Moves a time in the speech-only audio back onto the audio file, with the stretch it falls in. */
export function vadToOriginal(t: number, spans: VadSpan[]): { t: number; span: VadSpan } | null {
  let span = spans[0]
  if (!span) return null
  for (const s of spans) if (s.vadStart <= t + 1e-6) span = s
  return { t: Math.min(span.start + Math.max(0, t - span.vadStart), span.end + VAD_TAIL_SEC), span }
}

export interface WhisperTiming {
  /** From `whisperChunk`: where VAD kept speech, or null when VAD was off. */
  vad: VadSpan[] | null
}

interface ParsedWord extends Word {
  /** DTW start of the word's first piece, seconds (still in whisper's own time), or null. */
  dtw: number | null
}

/**
 * Reads whisper.cpp `-oj`/`-ojf` output produced with `-ml 1 -sow` (one word
 * per segment). Offsets are milliseconds from the start of the audio file.
 *
 * With `timing` given and DTW token times in the file (`-ojf -dtw`), word
 * starts come from DTW, which is far closer to the voice than whisper's own
 * per-word timestamps (those rush the words after a pause ahead of the
 * voice). Without them, or if any word lacks one, the plain timestamps are
 * used as before.
 */
export function parseWhisperJson(json: unknown, timing?: WhisperTiming): { language: string | null; words: Word[]; dtw: boolean } {
  const obj = (json ?? {}) as { result?: { language?: unknown }; transcription?: unknown }
  const language = typeof obj.result?.language === 'string' ? obj.result.language : null
  const segs = Array.isArray(obj.transcription) ? (obj.transcription as WhisperSegment[]) : []
  const words: ParsedWord[] = []
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
    words.push({ t0, t1, text, dtw: segmentDtw(seg) })
  }
  const dtwWords = timing ? applyDtw(words, timing) : null
  const plain = words.map(({ t0, t1, text }) => ({ t0, t1, text }))
  return { language, words: dropTailPileup(tidyWords(dtwWords ?? plain)), dtw: dtwWords !== null }
}

/** DTW time (seconds) of a segment's first real token, or null. */
function segmentDtw(seg: WhisperSegment): number | null {
  if (!Array.isArray(seg.tokens)) return null
  for (const tok of seg.tokens) {
    if (!tok || typeof tok.text !== 'string' || tok.text.startsWith('[_')) continue
    const t = Number(tok.t_dtw)
    return Number.isFinite(t) && t >= 0 ? t / 100 : null
  }
  return null
}

/**
 * Word times from DTW starts: each word starts at its DTW time less the
 * measured lag, never before the VAD stretch it is in (VAD finds the start
 * of speech very precisely), and ends at the next word, a plausible length
 * for its text, or the end of its stretch (less `VAD_END_TRIM_SEC`),
 * whichever comes first -- so words never run on into a pause. Null when any
 * word has no DTW time.
 */
function applyDtw(words: ParsedWord[], timing: WhisperTiming): Word[] | null {
  if (words.length === 0 || words.some((w) => w.dtw === null)) return null
  if (timing.vad && timing.vad.length === 0) return null
  const placed: { t0: number; text: string; spanEnd: number }[] = []
  for (const w of words) {
    const mapped = timing.vad ? vadToOriginal(w.dtw!, timing.vad)! : null
    const raw = mapped ? mapped.t : w.dtw!
    const floor = Math.max(mapped ? mapped.span.start : 0, placed[placed.length - 1]?.t0 ?? 0)
    placed.push({ t0: Math.round(Math.max(floor, raw - DTW_LAG_SEC) * 1000) / 1000, text: w.text, spanEnd: mapped ? mapped.span.end - VAD_END_TRIM_SEC : Infinity })
  }
  return placed.map((w, i) => {
    const next = placed[i + 1]
    const t1 = Math.min(next ? next.t0 : Infinity, w.t0 + maxPlausibleDuration(w.text), Math.max(w.spanEnd, w.t0 + MIN_SPAN_WORD_SEC))
    return { t0: w.t0, t1: Math.max(w.t0, t1), text: w.text }
  })
}

/**
 * Repairs a chunk's stretched words using its own voice-energy envelope
 * (both the words and the envelope are relative to the chunk's own audio, so
 * this runs before `placeChunkWords` moves them onto the VOD timeline). A
 * word is left alone when its span holds no clear, separate burst of speech,
 * or when the match it found is implausibly wide (it likely swallowed a
 * neighbouring word too); either way `repairWordTimings` catches it
 * afterwards with the text heuristic.
 */
export function repairChunkWordTimings(words: Word[], env: Float32Array, frameSec: number, opts: WordTimingOptions = DEFAULT_WORD_TIMING): Word[] {
  return words.map((w) => {
    if (!isStretchedWord(w, opts)) return w
    const want = maxPlausibleDuration(w.text, opts)
    const found = locateWordEnergy(env, frameSec, w.t0, w.t1)
    if (!found) return w
    const duration = found.t1 - found.t0
    if (duration < opts.minDuration * 0.5 || duration > want * 2.5) return w
    return { ...w, t0: found.t0, t1: found.t1 }
  })
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

/**
 * A chunk cut in the middle of a word can make whisper carry on past the end
 * of the audio ("... 6 7 8 9 10" from a count cut after 6); all those words
 * come out stamped at the same instant, the end of the audio. The next chunk
 * hears (and transcribes) the real ones, so keep only the first of such a run
 * at the very end. Both timestamp kinds do this.
 */
export function dropTailPileup(words: Word[], spreadSec = 0.02, minRun = 3): Word[] {
  let from = words.length - 1
  while (from > 0 && Math.abs(words[from - 1]!.t0 - words[words.length - 1]!.t0) <= spreadSec) from--
  return words.length - from >= minRun ? words.slice(0, from + 1) : words
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

/** The same word from the two chunks either side of a seam, this close in time, is one word. */
const SEAM_TWIN_SEC = 0.35

/** Merges per-chunk word lists, keeping each chunk's words inside its range. */
export function mergeChunks(chunks: { range: Range; words: Word[] }[]): Word[] {
  const all: { w: Word; chunk: number }[] = []
  chunks.forEach((c, chunk) => {
    for (const w of c.words) if (w.t0 >= c.range.start - 0.5 && w.t0 < c.range.end) all.push({ w, chunk })
  })
  // Chunks are cut in quiet spots, but a word heard by both sides of a seam
  // (each timed a little differently, DTW especially) must show up once.
  all.sort((a, b) => a.w.t0 - b.w.t0)
  const unique: Word[] = []
  let prev: { w: Word; chunk: number } | null = null
  for (const cur of all) {
    const twin = prev !== null && normalise(prev.w.text) === normalise(cur.w.text) && cur.w.t0 - prev.w.t0 < (prev.chunk === cur.chunk ? 0.05 : SEAM_TWIN_SEC)
    if (!twin) unique.push(cur.w)
    prev = cur
  }
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
