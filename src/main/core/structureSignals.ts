// Measures the shape of one already-cut clip -- where the reaction sits, how
// much build-up leads to it, whether a short verbatim line is quotable, how
// chat and speech compare -- so `structurePick.ts` can choose how to re-edit
// it. Pure and deterministic; every number comes from the clip's own words,
// chat and (when known) loudness, never invented.

import type { ChatMessage, Range, Word } from '@shared/types'
import { isKeywordWord } from '@shared/captions'
import { chatterBurstSeries } from './signals'
import { wordsIn } from './transcript'

/** A span as word indices into the clip's own `words` array, start and end inclusive. */
export interface WordSpan {
  start: number
  end: number
}

export interface ClipFacts {
  /** The cut, in VOD seconds (`Clip.start`/`Clip.end`). */
  window: Range
  /** Caption words covering the clip, VOD seconds (`Clip.words`; usually padded a little past `window`). */
  words: Word[]
  /** Chat messages covering the clip, VOD seconds, padded like `words` (`Clip.chatMessages`). */
  chatMessages: ChatMessage[]
  /**
   * Per-second dB covering at least `window` (a slice of the job's
   * `loudness.txt`, same shape as `MomentInputs.loudness` in `moments.ts`),
   * or null when it was not kept for this clip.
   */
  loudness: Float64Array | null
  /** The VOD second that `loudness[0]` represents; ignored when `loudness` is null. */
  loudnessOffset: number
}

export interface StructureSignals {
  clipLength: number
  /** 0..1, (peak - clip start) / clipLength. Near 0: the reaction is right at the top. */
  peakRatio: number
  /** Seconds from the clip's start to the peak (the same numerator as `peakRatio`, unnormalised). */
  setupLength: number
  /** 3-8 word spans within +-3 s of the peak, bounded by pauses or sentence punctuation, closest to the peak first. */
  quotableSpans: WordSpan[]
  /** Chat burst rate near the peak divided by the clip's speech-word rate; 0 with no chat, capped so a silent clip cannot produce Infinity. */
  chatRateRatio: number
  /** 0..1, fraction of the clip with no speech and (when loudness is known) no sound either. */
  silenceRatio: number
  /** Count of local maxima in the combined chat/loudness activity that come within 70% of the strongest one, at least 3 s apart. */
  subPeaks: number
  /** Where each of those `subPeaks` local maxima sits, clip-relative seconds, earliest first. Empty with no activity signal. */
  subPeakTimes: number[]
  /**
   * Seconds the chat burst's own peak comes before the combined (chat +
   * loudness) peak used for `peakRatio`; 0 when there is no separate chat
   * signal or chat does not lead. Feeds `chatFirst`, which is experimental
   * and scored conservatively -- see `structurePick.ts`.
   */
  chatLeadSec: number
}

/** Chat is judged in a much shorter rolling window than the whole-VOD finder: a clip is seconds long, not hours. */
const CHAT_WINDOW_SEC = 6
/** How close to the peak a word span must start to be "quotable". */
const QUOTE_RADIUS_SEC = 3
const QUOTE_MIN_WORDS = 3
const QUOTE_MAX_WORDS = 8
/** A gap at least this long, or a sentence-ending word, starts a new quotable span. */
const QUOTE_PAUSE_SEC = 0.5
/** At or below this many dB, a second counts as silent when loudness is known. */
const SILENCE_DB = -40
/** A local maximum within this fraction of the strongest one counts as a comparable sub-peak. */
const SUBPEAK_FRACTION = 0.7
const SUBPEAK_SEPARATION_SEC = 3

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** Builds a 0..1-normalised, one-value-per-second activity series over the clip, or null if there is nothing to build it from. */
function normalise(series: Float64Array): Float64Array {
  let min = Infinity
  let max = -Infinity
  for (const v of series) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || max - min < 1e-9) return new Float64Array(series.length)
  const out = new Float64Array(series.length)
  for (let i = 0; i < series.length; i++) out[i] = (series[i]! - min) / (max - min)
  return out
}

/** One value per second of the clip: loudness lifted out of true silence, or null when unknown. */
function audioSeries(facts: ClipFacts, seconds: number): Float64Array | null {
  if (!facts.loudness || facts.loudness.length === 0) return null
  const out = new Float64Array(seconds)
  for (let i = 0; i < seconds; i++) {
    const idx = Math.round(facts.window.start + i - facts.loudnessOffset)
    const db = idx >= 0 && idx < facts.loudness.length ? facts.loudness[idx]! : -60
    out[i] = Math.max(db, -60)
  }
  return out
}

/** One value per second of the clip: distinct-chatter reaction weight, or null with no chat at all. */
function chatSeries(facts: ClipFacts, seconds: number): Float64Array | null {
  if (facts.chatMessages.length === 0) return null
  const relative = facts.chatMessages.map((m) => ({ ...m, t: m.t - facts.window.start })).filter((m) => m.t >= -CHAT_WINDOW_SEC && m.t < seconds + CHAT_WINDOW_SEC)
  if (relative.length === 0) return null
  return chatterBurstSeries(relative, seconds, CHAT_WINDOW_SEC)
}

/** One value per second of the clip, from keyword-ish words (shouted, numeric, excited): the last resort when there is neither chat nor loudness. */
function wordSeries(words: Word[], window: Range, seconds: number): Float64Array {
  const out = new Float64Array(seconds)
  for (const w of wordsIn(words, window.start, window.end)) {
    const i = Math.max(0, Math.min(seconds - 1, Math.floor(w.t0 - window.start)))
    out[i] = out[i]! + (isKeywordWord(w.text) ? 2 : 0.3)
  }
  return out
}

/** Local maxima of `series` at least `minZ` of the top value, `separation` seconds apart, strongest first. */
function localPeaks(series: Float64Array, minFraction: number, separation: number): number[] {
  let max = 0
  for (const v of series) max = Math.max(max, v)
  if (max <= 0) return []
  const candidates: number[] = []
  for (let i = 0; i < series.length; i++) {
    const v = series[i]!
    if (v < max * minFraction) continue
    if ((i === 0 || v >= series[i - 1]!) && (i === series.length - 1 || v > series[i + 1]!)) candidates.push(i)
  }
  candidates.sort((a, b) => series[b]! - series[a]!)
  const picked: number[] = []
  for (const i of candidates) {
    if (picked.some((p) => Math.abs(p - i) < separation)) continue
    picked.push(i)
  }
  return picked
}

function argmax(series: Float64Array): number {
  let best = 0
  for (let i = 1; i < series.length; i++) if (series[i]! > series[best]!) best = i
  return best
}

/**
 * The 3-8 word spans within `QUOTE_RADIUS_SEC` of the peak whose edges sit at
 * a pause or sentence-ending punctuation, closest to the peak first. Only
 * whole boundary-to-boundary runs of a quotable length are returned: a longer
 * run (a whole rambling sentence) is not trimmed into a fake quote.
 */
function findQuotableSpans(words: Word[], peakTime: number): WordSpan[] {
  if (words.length === 0) return []
  // Sentence-shaped segments: a run of words with no long pause and no
  // sentence-ending punctuation before the last word.
  const segments: WordSpan[] = []
  let start = 0
  for (let i = 1; i <= words.length; i++) {
    const prev = words[i - 1]!
    const endsSentence = /[.!?]$/.test(prev.text)
    const gap = i < words.length ? words[i]!.t0 - prev.t1 : Infinity
    if (i === words.length || endsSentence || gap >= QUOTE_PAUSE_SEC) {
      segments.push({ start, end: i - 1 })
      start = i
    }
  }
  const near = segments.filter((s) => {
    const len = s.end - s.start + 1
    if (len < QUOTE_MIN_WORDS || len > QUOTE_MAX_WORDS) return false
    const mid = (words[s.start]!.t0 + words[s.end]!.t1) / 2
    return Math.abs(mid - peakTime) <= QUOTE_RADIUS_SEC
  })
  return near.sort((a, b) => {
    const da = Math.abs((words[a.start]!.t0 + words[a.end]!.t1) / 2 - peakTime)
    const db = Math.abs((words[b.start]!.t0 + words[b.end]!.t1) / 2 - peakTime)
    return da - db
  })
}

export function computeSignals(facts: ClipFacts): StructureSignals {
  const clipLength = Math.max(0.01, facts.window.end - facts.window.start)
  const seconds = Math.max(1, Math.ceil(clipLength))
  const clipWords = wordsIn(facts.words, facts.window.start, facts.window.end)

  const audio = audioSeries(facts, seconds)
  const chat = chatSeries(facts, seconds)
  const fallback = audio || chat ? null : wordSeries(facts.words, facts.window, seconds)

  // Loudness is the most direct evidence of the reaction itself (a laugh, a
  // scream), so it drives the peak whenever it is known; chat is a step
  // removed -- it is the crowd's response to the reaction, delayed by however
  // long it takes to read and type -- so it only takes over when there is no
  // audio at all, and otherwise is used just to measure how far it lags (or,
  // for chatFirst, leads) the real payoff. Word emphasis is the last resort.
  const primary = audio ?? chat ?? fallback
  const primaryNorm = primary ? normalise(primary) : null
  const chatNorm = chat ? normalise(chat) : null

  const peakSecond = primaryNorm ? Math.min(clipLength, argmax(primaryNorm)) : clipLength / 2
  const peakRatio = clamp01(peakSecond / clipLength)
  const setupLength = peakSecond
  const subPeakTimes = primaryNorm ? localPeaks(primaryNorm, SUBPEAK_FRACTION, SUBPEAK_SEPARATION_SEC).sort((a, b) => a - b) : []
  const subPeaks = subPeakTimes.length

  let chatLeadSec = 0
  if (chatNorm && primary !== chat) {
    const chatPeak = argmax(chatNorm)
    if (chatPeak < peakSecond) chatLeadSec = peakSecond - chatPeak
  }

  const peakTime = facts.window.start + peakSecond
  const quotableSpans = findQuotableSpans(clipWords, peakTime).map((s) => ({
    start: facts.words.indexOf(clipWords[s.start]!),
    end: facts.words.indexOf(clipWords[s.end]!)
  }))

  const speechRate = clipWords.length / clipLength
  let chatRateRatio = 0
  if (chat) {
    const nearFrom = Math.max(0, peakSecond - 5)
    const nearTo = Math.min(seconds - 1, peakSecond + 5)
    let nearSum = 0
    for (let i = Math.floor(nearFrom); i <= Math.ceil(nearTo); i++) nearSum += chat[i] ?? 0
    const chatRate = nearSum / (nearTo - nearFrom + 1)
    chatRateRatio = speechRate > 0.01 ? Math.min(10, chatRate / speechRate) : chatRate > 0 ? 10 : 0
  }

  let silentSeconds = 0
  for (let i = 0; i < seconds; i++) {
    const t = facts.window.start + i
    const hasWord = clipWords.some((w) => w.t1 > t && w.t0 < t + 1)
    const idx = Math.round(t - facts.loudnessOffset)
    const db = facts.loudness && idx >= 0 && idx < facts.loudness.length ? facts.loudness[idx]! : null
    const silent = db !== null ? db <= SILENCE_DB : !hasWord
    if (silent) silentSeconds++
  }
  const silenceRatio = clamp01(silentSeconds / seconds)

  return { clipLength, peakRatio, setupLength, quotableSpans, chatRateRatio, silenceRatio, subPeaks, subPeakTimes, chatLeadSec }
}
