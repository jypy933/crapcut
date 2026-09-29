import { describe, expect, it } from 'vitest'
import type { ChatMessage, Word } from '@shared/types'
import { computeSignals, type ClipFacts } from './structureSignals'

/** A word every `gap` seconds, `n` of them, starting at `start` (VOD seconds). Plain text, no digits, so `isKeywordWord` only fires on an explicit override. */
function speech(start: number, n: number, gap = 0.4, wordLen = 0.3, textAt: Record<number, string> = {}): Word[] {
  const out: Word[] = []
  for (let i = 0; i < n; i++) {
    const t0 = start + i * gap
    out.push({ t0, t1: t0 + wordLen, text: textAt[i] ?? 'blah' })
  }
  return out
}

/** Flat quiet loudness with a loud burst of `db` dB for `len` seconds at `at` (VOD seconds), offset 0. */
function loudness(totalSec: number, at: number, len: number, db: number): Float64Array {
  const out = new Float64Array(totalSec).fill(-50)
  for (let t = Math.max(0, Math.floor(at)); t < Math.min(totalSec, Math.ceil(at + len)); t++) out[t] = db
  return out
}

function chatBurst(at: number, len: number, perSec: number, users = 'abcdefgh'): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let t = at; t < at + len; t++) for (let k = 0; k < perSec; k++) out.push({ t: t + k / perSec, user: `${users[k % users.length]}${t}`, text: 'KEKW' })
  return out
}

function facts(partial: Partial<ClipFacts>): ClipFacts {
  return { window: { start: 0, end: 30 }, words: [], chatMessages: [], loudness: null, loudnessOffset: 0, ...partial }
}

describe('computeSignals: peak placement', () => {
  it('places the peak early for a payoff-shaped clip (loud right at the start)', () => {
    const s = computeSignals(facts({ window: { start: 100, end: 130 }, loudness: loudness(200, 102, 3, -5), loudnessOffset: 0 }))
    expect(s.peakRatio).toBeLessThan(0.15)
    expect(s.setupLength).toBeLessThan(3)
  })

  it('places the peak mid-clip for a build-up (ramp) shape', () => {
    // Loud only around 30% into a 30 s clip, quiet elsewhere.
    const s = computeSignals(facts({ window: { start: 0, end: 30 }, loudness: loudness(30, 9, 2, -5), loudnessOffset: 0 }))
    expect(s.peakRatio).toBeGreaterThanOrEqual(0.15)
    expect(s.peakRatio).toBeLessThanOrEqual(0.45)
  })

  it('places the peak late for a freeze-loop shape', () => {
    const s = computeSignals(facts({ window: { start: 0, end: 30 }, loudness: loudness(30, 27, 2, -5), loudnessOffset: 0 }))
    expect(s.peakRatio).toBeGreaterThan(0.8)
  })
})

describe('computeSignals: quotable spans', () => {
  it('finds a 3-8 word span near the peak bounded by a pause', () => {
    const words = [
      ...speech(90, 5, 0.4), // ends at ~91.6, well before the pause
      ...speech(101, 4, 0.35, 0.3, { 0: 'no', 1: 'way', 2: 'he', 3: 'hit.' }) // near peak at 102
    ]
    const s = computeSignals(facts({ window: { start: 90, end: 120 }, words, loudness: loudness(200, 102, 2, -5) }))
    expect(s.quotableSpans.length).toBeGreaterThan(0)
    const span = s.quotableSpans[0]!
    expect(span.end - span.start + 1).toBeGreaterThanOrEqual(3)
    expect(span.end - span.start + 1).toBeLessThanOrEqual(8)
    expect(words[span.start]!.text).toBe('no')
  })

  it('does not return a span longer than 8 words as quotable', () => {
    const words = speech(99, 12, 0.3) // one long unbroken run spanning the peak
    const s = computeSignals(facts({ window: { start: 90, end: 120 }, words, loudness: loudness(200, 102, 2, -5) }))
    expect(s.quotableSpans).toEqual([])
  })

  it('returns no spans with no words', () => {
    const s = computeSignals(facts({ window: { start: 0, end: 20 } }))
    expect(s.quotableSpans).toEqual([])
  })
})

describe('computeSignals: chat vs speech rate', () => {
  it('is high when chat bursts and speech is sparse', () => {
    const words = speech(0, 3, 5) // three words, far apart: a low speech rate
    const s = computeSignals(facts({ window: { start: 0, end: 20 }, words, chatMessages: chatBurst(9, 4, 10) }))
    expect(s.chatRateRatio).toBeGreaterThan(1)
  })

  it('is 0 with no chat', () => {
    const s = computeSignals(facts({ window: { start: 0, end: 20 }, words: speech(0, 20, 0.5) }))
    expect(s.chatRateRatio).toBe(0)
  })

  it('reports a lead time when chat bursts before the loud payoff', () => {
    const s = computeSignals(
      facts({
        window: { start: 0, end: 30 },
        chatMessages: chatBurst(5, 3, 10),
        loudness: loudness(30, 15, 2, -5)
      })
    )
    expect(s.chatLeadSec).toBeGreaterThan(2)
  })
})

describe('computeSignals: silence and sub-peaks', () => {
  it('reports high silenceRatio for a mostly-quiet clip with sparse words', () => {
    const s = computeSignals(facts({ window: { start: 0, end: 30 }, words: speech(0, 2, 1), loudness: loudness(30, 15, 2, -5) }))
    expect(s.silenceRatio).toBeGreaterThan(0.5)
  })

  it('reports low silenceRatio for a clip full of speech', () => {
    const s = computeSignals(facts({ window: { start: 0, end: 20 }, words: speech(0, 50, 0.35) }))
    expect(s.silenceRatio).toBeLessThan(0.3)
  })

  it('counts 3+ comparable sub-peaks for a rapid-fire shape', () => {
    const l = new Float64Array(40).fill(-50)
    for (const at of [4, 14, 24, 34]) for (let t = at; t < at + 2; t++) l[t] = -5
    const s = computeSignals(facts({ window: { start: 0, end: 40 }, loudness: l }))
    expect(s.subPeaks).toBeGreaterThanOrEqual(3)
  })

  it('counts a single sub-peak for a clean single-spike clip', () => {
    const s = computeSignals(facts({ window: { start: 0, end: 30 }, loudness: loudness(30, 15, 2, -5) }))
    expect(s.subPeaks).toBe(1)
  })
})

describe('computeSignals: degraded inputs', () => {
  it('handles no loudness, no chat and no words without throwing', () => {
    const s = computeSignals(facts({ window: { start: 0, end: 20 } }))
    expect(s.peakRatio).toBeGreaterThanOrEqual(0)
    expect(s.peakRatio).toBeLessThanOrEqual(1)
    expect(s.quotableSpans).toEqual([])
    expect(s.chatRateRatio).toBe(0)
    expect(Number.isFinite(s.silenceRatio)).toBe(true)
    expect(s.subPeaks).toBe(0)
  })

  it('falls back to keyword words when there is no chat or loudness', () => {
    const words = speech(0, 10, 1, 0.3, { 5: 'NO!' })
    const s = computeSignals(facts({ window: { start: 0, end: 10 }, words }))
    // The shouted word at index 5 (t0=5) should pull the peak toward the middle of the clip.
    expect(s.setupLength).toBeGreaterThan(2)
    expect(s.setupLength).toBeLessThan(8)
  })

  it('handles a very short clip', () => {
    const s = computeSignals(facts({ window: { start: 0, end: 0.5 }, words: speech(0, 1, 0.1) }))
    expect(Number.isFinite(s.peakRatio)).toBe(true)
    expect(s.clipLength).toBeCloseTo(0.5)
  })
})
