// Finds candidate moments from chat and audio signals and turns them into clip
// windows snapped to pauses in speech. Pure and deterministic.

import type { Range, Word } from '@shared/types'
import type { ChatMessage } from './chat'
import { overlapSeconds } from './media'
import { chatterBurstSeries, distinctChatters, findPeaks, maxIn, movingAverage, robustZ, type Series } from './signals'
import { DEFAULT_TASTE_ADJUSTMENTS, type TasteAdjustments } from './taste'
import { wordsIn } from './transcript'

export interface MomentInputs {
  durationSec: number
  messages: ChatMessage[]
  /** dB per second, or null when unknown. */
  loudness: Float64Array | null
  words: Word[]
  muted: Range[]
}

export interface Candidate {
  /** Second where the reaction peaked. */
  peak: number
  /** Estimated second the moment itself happened. */
  event: number
  /** Heuristic clip window. */
  window: Range
  /** Combined signal strength, unbounded. */
  strength: number
  /** 0..1 */
  score: number
  chatZ: number
  audioZ: number
  reasons: string[]
}

export const CLIP_MIN_SEC = 12
export const CLIP_MAX_SEC = 60
/** Viewers see the stream a few seconds late and need a moment to type. */
export const CHAT_DELAY_SEC = 7
/**
 * Stream starts ("LIVE Pog") and ends ("gn") are never clips: skip the first
 * two minutes and the last minute, less on short VODs.
 */
export function edgeSkip(durationSec: number): { start: number; end: number } {
  return { start: Math.min(120, Math.max(15, durationSec * 0.05)), end: Math.min(60, Math.max(10, durationSec * 0.03)) }
}

/** Always keep at least this many clips when that many candidates exist at all. */
export const MIN_CLIPS = 3

/**
 * The most clips a job will ever produce, so a great stream does not
 * overwhelm review: about one clip per 20 minutes of stream, capped at 20.
 * The actual count is decided by `selectByQuality`, which rarely reaches
 * this ceiling; it exists only to keep the review list manageable.
 */
export function maxClipCount(durationSec: number): number {
  return Math.max(MIN_CLIPS, Math.min(20, Math.round(durationSec / 1200)))
}

const LAUGH = /\b(kekw|kekl|lul|lulw|omegalul|lmao+|lol+|icant|pepelaugh|xd+|mdr+|ptdr+|haha+)\b|😂|🤣|💀/i
const HYPE = /\b(pog\w*|poggers|holy|no ?way|lets ?go+|clip|clutch|insane|w+)\b/i

/**
 * Floor under the chat z-score's scale: a burst summing to less than this
 * many weighted-distinct-chatter units never counts as more than a mild
 * blip, even in a dead-quiet chat where the rolling median and spread are
 * both zero. Without it, one or two ordinary reactions in an otherwise
 * silent window would divide by almost nothing and look enormous.
 */
const CHATTER_Z_FLOOR = 3
/** A confirmed chat reaction's z-score is added on top of this base, see below. */
const CHAT_BASE = 1.5
/** Loudness peaks below this are not candidates at all. */
export const LOUD_MIN_Z = 3

/** True when a clip's stored `audioZ` is a loudness peak by the same bar moment finding uses. */
export function isLoudPeak(audioZ: number | null | undefined): boolean {
  return (audioZ ?? 0) >= LOUD_MIN_Z
}
/** Strength of a loud-only moment right at the detection threshold. */
const LOUD_BASE = 1.2
/** How fast a loud-only moment's strength grows past the threshold (log-compressed, see below). */
const LOUD_SCALE = 1.3

function reasonsFor(messages: ChatMessage[], from: number, to: number): string[] {
  let n = 0
  let laugh = 0
  let hype = 0
  for (const m of messages) {
    if (m.t < from) continue
    if (m.t > to) break
    n++
    if (LAUGH.test(m.text)) laugh++
    if (HYPE.test(m.text)) hype++
  }
  const out: string[] = []
  if (n > 0 && laugh / n >= 0.25) out.push('laughter')
  if (n > 0 && hype / n >= 0.25) out.push('hype')
  return out
}

/** Maps an unbounded strength to 0..1. */
export function strengthToScore(strength: number): number {
  return Math.max(0, Math.min(1, 1 - Math.exp(-Math.max(0, strength) / 6)))
}

/**
 * Inverse of `strengthToScore`, for a caller that only has a bounded 0..1
 * signal (the transcript scan gives a fixed nominal strength, not a z-score)
 * and needs a comparable raw strength to rank and quality-gate alongside
 * chat- and audio-backed candidates.
 */
export function scoreToStrength(score: number): number {
  return -6 * Math.log(1 - Math.max(0, Math.min(0.999999, score)))
}

/**
 * Picks the start and end of a clip around an event, snapped to pauses in
 * speech so sentences are not cut in half.
 */
export function snapWindow(words: Word[], target: Range, durationSec: number, minGap = 0.35, reach = 8): Range {
  let { start, end } = target
  const near = wordsIn(words, start - reach - 2, end + reach + 2)
  // Start: the latest pause at or before the target start, within reach.
  let bestStart: number | null = null
  for (let i = 0; i < near.length; i++) {
    const w = near[i]!
    const prevEnd = i > 0 ? near[i - 1]!.t1 : -Infinity
    if (w.t0 - prevEnd >= minGap && w.t0 <= start + 1 && w.t0 >= start - reach) bestStart = w.t0
  }
  // If the target start lands mid-sentence and no pause is close, back up to it.
  if (bestStart !== null) start = Math.max(0, bestStart - 0.15)
  // End: the first pause at or after the target end, within reach.
  for (let i = 0; i < near.length; i++) {
    const w = near[i]!
    const nextStart = i < near.length - 1 ? near[i + 1]!.t0 : Infinity
    if (w.t1 >= end - 1 && w.t1 <= end + reach && nextStart - w.t1 >= minGap) {
      end = w.t1 + 0.3
      break
    }
  }
  start = Math.max(0, start)
  end = Math.min(durationSec, end)
  if (end - start > CLIP_MAX_SEC) end = start + CLIP_MAX_SEC
  if (end - start < CLIP_MIN_SEC) {
    const missing = CLIP_MIN_SEC - (end - start)
    start = Math.max(0, start - missing / 2)
    end = Math.min(durationSec, start + CLIP_MIN_SEC)
  }
  return { start: round2(start), end: round2(end) }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Default window: context before the moment, the streamer's reaction after. */
export function defaultWindow(event: number, peak: number, adjustments: TasteAdjustments = DEFAULT_TASTE_ADJUSTMENTS): Range {
  const { leadInSec, leadOutSec } = adjustments
  return { start: event - leadInSec, end: Math.max(event + leadOutSec, peak - CHAT_DELAY_SEC + leadOutSec) }
}

export interface FindOptions {
  /** How many candidates to return (before any LLM re-ranking). */
  limit: number
}

/** All candidates, strongest first. */
export function findCandidates(inputs: MomentInputs, opts: FindOptions, adjustments: TasteAdjustments = DEFAULT_TASTE_ADJUSTMENTS): Candidate[] {
  const { durationSec, loudness, words, muted } = inputs
  const messages = [...inputs.messages].sort((a, b) => a.t - b.t)
  const n = Math.max(1, Math.ceil(durationSec))

  // How many different chatters reacted in a rolling ~20 s window, not raw
  // message counts: a small, slow chat can show a real reaction as just a
  // handful of different regulars, which per-second message counts barely
  // move; a big, fast chat is judged against its own much busier normal, so
  // the same handful means nothing there.
  const chatZ: Series = robustZ(chatterBurstSeries(messages, durationSec), 600, CHATTER_Z_FLOOR)
  let audioZ: Series = new Float64Array(n)
  if (loudness && loudness.length > 0) {
    // Ignore silence (muted/AFK) when judging what "normal loudness" is.
    const lifted = loudness.map((db) => Math.max(db, -60))
    audioZ = robustZ(movingAverage(lifted, 3), 600, 1.5)
  }

  const skip = edgeSkip(durationSec)
  const inside = (t: number): boolean => t >= skip.start && t <= durationSec - skip.end
  const raw: Candidate[] = []
  const add = (peak: number, onset: number, strength: number, cz: number, az: number, reasons: string[]): void => {
    const event = Math.max(0, onset - (cz > 0 ? CHAT_DELAY_SEC : 1))
    const window = snapWindow(words, defaultWindow(event, cz > 0 ? peak : peak + CHAT_DELAY_SEC, adjustments), durationSec)
    raw.push({ peak, event, window, strength, score: strengthToScore(strength), chatZ: cz, audioZ: az, reasons })
  }

  // Start strict; relax when a quiet or short stream gives too few moments.
  // (Detection thresholds are never adjusted by taste, only how candidates
  // that pass them are ranked, so learning can't make the finder pick
  // nothing or everything.)
  let chatPeaks = findPeaks(chatZ, 2.5, 45)
  for (const minZ of [2, 1.6]) {
    if (chatPeaks.filter((p) => inside(p.t)).length >= opts.limit / 2) break
    chatPeaks = findPeaks(chatZ, minZ, 45)
  }
  // A handful of different people reacting together is real even in a quiet
  // chat; this is a sanity floor, not the main filter -- the z-score above
  // already judges the burst against this stream's own normal, so in a big
  // fast chat it takes far more than 3 people to register as a peak at all.
  const CHATTER_GATE_SEC = 10
  for (const p of chatPeaks) {
    if (!inside(p.t)) continue
    if (distinctChatters(messages, p.onset - CHATTER_GATE_SEC, p.t + CHATTER_GATE_SEC) < 3) continue
    const az = Math.max(0, maxIn(audioZ, p.onset - CHAT_DELAY_SEC - 15, p.t - CHAT_DELAY_SEC + 5))
    const reasons = ['Chat spike', ...reasonsFor(messages, p.onset - 1, p.t + 4)]
    if (az >= 2.5) reasons.push('loud')
    // A confirmed chat reaction starts from a solid base before its own
    // z-score is added, so it is not automatically buried under a loud but
    // unconfirmed moment: loudness alone can reach a far higher z than chat
    // ever does (an explosion dwarfs any crowd reaction after normalising),
    // so without this base a real reaction that chat calmly agreed on would
    // rank below background game noise.
    add(p.t, p.onset, adjustments.chatWeight * (CHAT_BASE + p.z) + 0.5 * adjustments.audioWeight * Math.min(az, 6), p.z, az, reasons)
  }

  // Loud moments chat did not react to (useful for small chats). Loudness has
  // no natural ceiling -- a big explosion can dwarf anything else in the
  // stream -- so its contribution is compressed with a log: a moment several
  // times louder than the threshold clearly outranks one that just clears
  // it, but it cannot grow without bound and swamp every chat-backed
  // candidate just for being extremely loud.
  for (const p of findPeaks(audioZ, LOUD_MIN_Z, 60)) {
    if (!inside(p.t)) continue
    if (raw.some((c) => Math.abs(c.event - p.t) < 30)) continue
    const loud = LOUD_BASE + LOUD_SCALE * Math.log1p(Math.max(0, p.z - LOUD_MIN_Z))
    add(p.t, p.onset, adjustments.audioWeight * loud, 0, p.z, ['Loud moment'])
  }

  return selectNonOverlapping(
    raw.filter((c) => overlapSeconds(c.window, muted) <= 0.25 * (c.window.end - c.window.start)),
    opts.limit
  )
}

/** Strongest first, no two windows overlapping or closer than `gap` seconds. */
export function selectNonOverlapping<T extends { window: Range; strength: number }>(items: T[], limit: number, gap = 5): T[] {
  const sorted = [...items].sort((a, b) => b.strength - a.strength)
  const out: T[] = []
  for (const c of sorted) {
    if (out.length >= limit) break
    if (out.some((o) => c.window.start < o.window.end + gap && o.window.start < c.window.end + gap)) continue
    out.push(c)
  }
  return out
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * How far above its own group's typical strength (in robust "spreads") a
 * loud-only candidate must be to clear the bar. Computed the same way as the
 * time-series z-scores above, but over the strengths of one stream's own
 * loud-only candidates, so it adapts to how loud and how spiky this
 * particular stream's audio is instead of using one fixed number for every
 * stream.
 */
const LOUD_QUALITY_Z = 0.8

/** Lowest a loud-only group's bar is allowed to be relative to its median. */
const LOUD_QUALITY_FLOOR = 0.15

/**
 * How much above its own group's median a candidate needs to be, in that
 * group's own robust spread, floored so a group where every candidate is
 * about equally strong does not become impossible to clear.
 */
function groupBar(strengths: number[], z: number): number {
  if (strengths.length === 0) return Infinity
  const sorted = [...strengths].sort((a, b) => a - b)
  const med = median(sorted)
  const mad = median(sorted.map((s) => Math.abs(s - med)))
  const scale = Math.max(1.4826 * mad, LOUD_QUALITY_FLOOR * med)
  return med + z * scale
}

/** A model rating (1..10) at or below this is the model saying no. */
export const LOW_RATING = 3

function isLowRated(rating: number | null | undefined): boolean {
  return rating !== null && rating !== undefined && rating <= LOW_RATING
}

/**
 * Picks clips by quality instead of always filling to a fixed count. Chat-
 * and transcript-backed candidates already passed their own selective
 * checks (a real burst of different chatters, or the model's own rating) and
 * normally skip the loud-only bar below. Loud-only candidates get an extra
 * bar relative to this stream's *other* loud-only candidates -- audio has no
 * natural ceiling and (especially in a loud game) can turn up many
 * technically-above-baseline moments that are merely loud rather than
 * notable, so only the ones that stand out even among those are kept
 * (`strength` is expected to already fold in the model's rating when there
 * is one, so a loud moment it rates highly can still clear this bar).
 *
 * Whatever the source, a candidate the model rated `LOW_RATING` or below is
 * dropped outright -- that overrides even a chat- or transcript-backed
 * candidate's usual free pass, since a real burst of chatters can still be
 * about something not worth a clip. Never fewer than `min` clips while that
 * many candidates exist at all (a very negative model is not allowed to
 * empty the list), never more than `max`.
 */
export function selectByQuality<T extends { window: Range; strength: number; chatZ: number; audioZ: number; rating?: number | null }>(
  items: T[],
  min: number,
  max: number
): T[] {
  if (items.length === 0) return []
  const ranked = selectNonOverlapping(items, Math.max(max, items.length))
  // Loud-only: no chat confirmation and only found because of loudness.
  // Chat-backed and transcript-only candidates (chatZ and audioZ both 0)
  // already passed their own selective checks and skip this bar entirely.
  const isLoudOnly = (c: T): boolean => c.chatZ <= 0 && c.audioZ > 0
  const bar = groupBar(
    ranked.filter(isLoudOnly).map((c) => c.strength),
    LOUD_QUALITY_Z
  )
  let kept = ranked.filter((c) => !isLowRated(c.rating) && (!isLoudOnly(c) || c.strength >= bar))
  if (kept.length < Math.min(min, ranked.length)) kept = ranked.slice(0, min)
  return kept.slice(0, max)
}

/** A short title from the words of a clip, used when the LLM is unavailable. */
export function fallbackTitle(words: Word[], window: Range): string {
  const inside = wordsIn(words, window.start, window.end)
  if (inside.length === 0) return 'Untitled moment'
  // The sentence closest to the middle of the clip reads best as a teaser.
  const mid = (window.start + window.end) / 2
  let best = inside[0]!
  for (const w of inside) if (Math.abs(w.t0 - mid) < Math.abs(best.t0 - mid)) best = w
  const idx = inside.indexOf(best)
  let s = idx
  while (s > 0 && !/[.!?]$/.test(inside[s - 1]!.text) && idx - s < 6) s--
  const picked = inside.slice(s, s + 8).map((w) => w.text)
  let title = picked.join(' ').replace(/\s+([,.!?])/g, '$1')
  title = title.replace(/[,;:]$/, '')
  if (title.length > 60) title = `${title.slice(0, 57).trimEnd()}…`
  return title.charAt(0).toUpperCase() + title.slice(1)
}
