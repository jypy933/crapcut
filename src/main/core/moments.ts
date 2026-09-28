// Finds candidate moments from chat and audio signals and turns them into clip
// windows snapped to pauses in speech. Pure and deterministic.

import type { Range, Word } from '@shared/types'
import type { ChatMessage } from './chat'
import { overlapSeconds } from './media'
import { chatSeries, findPeaks, maxIn, movingAverage, robustZ, type Series } from './signals'
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

/** About one clip per 20 minutes of stream, between 3 and 20. */
export function targetClipCount(durationSec: number): number {
  return Math.max(3, Math.min(20, Math.round(durationSec / 1200)))
}

const LAUGH = /\b(kekw|kekl|lul|lulw|omegalul|lmao+|lol+|icant|pepelaugh|xd+|mdr+|ptdr+|haha+)\b|😂|🤣|💀/i
const HYPE = /\b(pog\w*|poggers|holy|no ?way|lets ?go+|clip|clutch|insane|w+)\b/i

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

function uniqueChatters(messages: ChatMessage[], from: number, to: number): number {
  const set = new Set<string>()
  for (const m of messages) {
    if (m.t < from) continue
    if (m.t > to) break
    set.add(m.user.toLowerCase())
  }
  return set.size
}

/** Maps an unbounded strength to 0..1. */
export function strengthToScore(strength: number): number {
  return Math.max(0, Math.min(1, 1 - Math.exp(-Math.max(0, strength) / 6)))
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
export function defaultWindow(event: number, peak: number): Range {
  return { start: event - 18, end: Math.max(event + 10, peak - CHAT_DELAY_SEC + 10) }
}

export interface FindOptions {
  /** How many candidates to return (before any LLM re-ranking). */
  limit: number
}

/** All candidates, strongest first. */
export function findCandidates(inputs: MomentInputs, opts: FindOptions): Candidate[] {
  const { durationSec, loudness, words, muted } = inputs
  const messages = [...inputs.messages].sort((a, b) => a.t - b.t)
  const n = Math.max(1, Math.ceil(durationSec))

  const chatZ: Series = robustZ(movingAverage(chatSeries(messages, durationSec), 8), 600, 0.2)
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
    const window = snapWindow(words, defaultWindow(event, cz > 0 ? peak : peak + CHAT_DELAY_SEC), durationSec)
    raw.push({ peak, event, window, strength, score: strengthToScore(strength), chatZ: cz, audioZ: az, reasons })
  }

  // Start strict; relax when a quiet or short stream gives too few moments.
  let chatPeaks = findPeaks(chatZ, 2.5, 45)
  for (const minZ of [2, 1.6]) {
    if (chatPeaks.filter((p) => inside(p.t)).length >= opts.limit / 2) break
    chatPeaks = findPeaks(chatZ, minZ, 45)
  }
  for (const p of chatPeaks) {
    if (!inside(p.t)) continue
    if (uniqueChatters(messages, p.onset - 2, p.t + 2) < 3) continue
    const az = Math.max(0, maxIn(audioZ, p.onset - CHAT_DELAY_SEC - 15, p.t - CHAT_DELAY_SEC + 5))
    const reasons = ['Chat spike', ...reasonsFor(messages, p.onset - 1, p.t + 4)]
    if (az >= 2.5) reasons.push('loud')
    add(p.t, p.onset, p.z + 0.5 * Math.min(az, 6), p.z, az, reasons)
  }

  // Loud moments chat did not react to (useful for small chats).
  for (const p of findPeaks(audioZ, 3, 60)) {
    if (!inside(p.t)) continue
    if (raw.some((c) => Math.abs(c.event - p.t) < 30)) continue
    add(p.t, p.onset, 0.6 * p.z, 0, p.z, ['Loud moment'])
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
