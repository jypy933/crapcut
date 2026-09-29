import { describe, expect, it } from 'vitest'
import type { Range, Word } from '@shared/types'
import type { ChatMessage } from './chat'
import {
  CHAT_DELAY_SEC,
  CLIP_MAX_SEC,
  CLIP_MIN_SEC,
  defaultWindow,
  edgeSkip,
  fallbackTitle,
  findCandidates,
  LOW_RATING,
  maxClipCount,
  MIN_CLIPS,
  scoreToStrength,
  selectByQuality,
  selectNonOverlapping,
  snapWindow,
  strengthToScore
} from './moments'
import { DEFAULT_TASTE_ADJUSTMENTS, deriveTasteAdjustments } from './taste'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function chat(duration: number, spikes: { at: number; text: string; perSec: number }[]): ChatMessage[] {
  const r = rng(7)
  const out: ChatMessage[] = []
  for (let t = 0; t < duration; t++) {
    if (r() < 0.6) out.push({ t: t + r(), user: `u${Math.floor(r() * 2000)}`, text: 'chatting' })
  }
  for (const s of spikes)
    for (let t = s.at; t < s.at + 8; t++)
      for (let k = 0; k < s.perSec; k++) out.push({ t: t + r(), user: `s${s.at}_${t}_${k}`, text: s.text })
  return out.sort((a, b) => a.t - b.t)
}

/** A word every 0.4 s with a pause every 12 words. */
function speech(duration: number): Word[] {
  const out: Word[] = []
  let t = 0
  let i = 0
  while (t < duration) {
    out.push({ t0: t, t1: t + 0.3, text: `word${i}${i % 12 === 11 ? '.' : ''}` })
    t += i % 12 === 11 ? 1.2 : 0.4
    i++
  }
  return out
}

describe('maxClipCount', () => {
  it('scales with duration within limits', () => {
    expect(maxClipCount(600)).toBe(MIN_CLIPS)
    expect(maxClipCount(4 * 3600)).toBe(12)
    expect(maxClipCount(20 * 3600)).toBe(20)
  })
})

describe('edgeSkip', () => {
  it('skips stream start and end, less on short VODs', () => {
    expect(edgeSkip(4 * 3600)).toEqual({ start: 120, end: 60 })
    expect(edgeSkip(600)).toEqual({ start: 30, end: 18 })
    expect(edgeSkip(100)).toEqual({ start: 15, end: 10 })
  })
})

describe('strengthToScore', () => {
  it('is monotonic in 0..1', () => {
    expect(strengthToScore(-1)).toBe(0)
    expect(strengthToScore(3)).toBeLessThan(strengthToScore(9))
    expect(strengthToScore(1000)).toBeLessThanOrEqual(1)
  })
})

describe('scoreToStrength', () => {
  it('inverts strengthToScore', () => {
    for (const s of [0.5, 1.5, 4, 9]) expect(scoreToStrength(strengthToScore(s))).toBeCloseTo(s, 5)
  })
  it('clamps to a sane range', () => {
    expect(scoreToStrength(0)).toBeCloseTo(0, 10)
    expect(scoreToStrength(1)).toBeGreaterThan(0)
    expect(Number.isFinite(scoreToStrength(1))).toBe(true)
  })
})

describe('snapWindow', () => {
  const words = speech(300)
  it('snaps to pauses and respects length limits', () => {
    const w = snapWindow(words, { start: 100, end: 130 }, 300)
    expect(w.end - w.start).toBeGreaterThanOrEqual(CLIP_MIN_SEC)
    expect(w.end - w.start).toBeLessThanOrEqual(CLIP_MAX_SEC)
    // The start sits just before a word that follows a pause.
    const first = words.find((x) => x.t0 >= w.start)!
    const before = words[words.indexOf(first) - 1]!
    expect(first.t0 - before.t1).toBeGreaterThanOrEqual(0.35)
  })
  it('clamps to the VOD and enforces minimum length', () => {
    expect(snapWindow([], { start: -5, end: 2 }, 300)).toEqual({ start: 0, end: CLIP_MIN_SEC })
    const long = snapWindow([], { start: 10, end: 200 }, 300)
    expect(long.end - long.start).toBe(CLIP_MAX_SEC)
    const atEnd = snapWindow([], { start: 295, end: 305 }, 300)
    expect(atEnd.end).toBeLessThanOrEqual(300)
  })
})

describe('defaultWindow', () => {
  it('uses the default 18 s lead-in and 10 s lead-out with no adjustments', () => {
    expect(defaultWindow(100, 100)).toEqual({ start: 82, end: Math.max(110, 100 - CHAT_DELAY_SEC + 10) })
  })
  it('follows learned lead-in and lead-out padding', () => {
    const w = defaultWindow(100, 100, { ...DEFAULT_TASTE_ADJUSTMENTS, leadInSec: 10, leadOutSec: 5 })
    expect(w.start).toBe(90)
    expect(w.end).toBe(Math.max(105, 100 - CHAT_DELAY_SEC + 5))
  })
})

describe('findCandidates', () => {
  const duration = 3600
  const inputs = {
    durationSec: duration,
    messages: chat(duration, [
      { at: 30, text: 'LIVE Pog', perSec: 20 },
      { at: 1000, text: 'KEKW', perSec: 12 },
      { at: 2500, text: 'POGGERS clip it', perSec: 20 },
      { at: 3000, text: 'KEKW', perSec: 10 }
    ]),
    loudness: null,
    words: speech(duration),
    muted: [{ start: 2950, end: 3050 }]
  }
  const cands = findCandidates(inputs, { limit: 10 })

  it('finds the spikes, strongest first, with reasons', () => {
    expect(cands.length).toBeGreaterThanOrEqual(2)
    expect(cands[0]!.peak).toBeGreaterThan(2495)
    expect(cands[0]!.peak).toBeLessThan(2515)
    expect(cands[0]!.reasons).toContain('hype')
    const laugh = cands.find((c) => c.peak > 995 && c.peak < 1015)
    expect(laugh?.reasons).toContain('laughter')
  })

  it('puts the moment before the chat reaction', () => {
    const c = cands[0]!
    expect(c.event).toBeLessThan(c.peak)
    expect(c.window.start).toBeLessThan(c.event)
    expect(c.window.end).toBeGreaterThan(c.event)
  })

  it('skips the stream start and muted parts', () => {
    expect(cands.some((c) => c.peak < 120)).toBe(false)
    expect(cands.some((c) => c.peak > 2990 && c.peak < 3020)).toBe(false)
  })

  it('finds loud moments when chat is silent', () => {
    const loud = new Float64Array(duration).fill(-30)
    for (let t = 1800; t < 1806; t++) loud[t] = -8
    const r = findCandidates({ ...inputs, messages: [], loudness: loud, muted: [] }, { limit: 5 })
    expect(r).toHaveLength(1)
    expect(r[0]!.reasons).toEqual(['Loud moment'])
    expect(r[0]!.window.start).toBeLessThan(1800)
    expect(r[0]!.window.end).toBeGreaterThan(1805)
  })

  it('returns nothing for an empty stream', () => {
    expect(findCandidates({ ...inputs, messages: [], words: [], muted: [] }, { limit: 5 })).toEqual([])
  })

  it('finds the same moments with no taste history as with no adjustments at all', () => {
    const withNoHistory = findCandidates(inputs, { limit: 10 }, deriveTasteAdjustments([]))
    expect(withNoHistory).toEqual(cands)
  })

  it('reweighting chat vs audio changes which candidates rank strongest, without changing how many pass', () => {
    const chatFavoured = findCandidates(inputs, { limit: 10 }, { ...DEFAULT_TASTE_ADJUSTMENTS, chatWeight: 1.5, audioWeight: 0.6 })
    const audioFavoured = findCandidates(inputs, { limit: 10 }, { ...DEFAULT_TASTE_ADJUSTMENTS, chatWeight: 0.6, audioWeight: 1.5 })
    expect(chatFavoured).toHaveLength(cands.length)
    expect(audioFavoured).toHaveLength(cands.length)
    expect(chatFavoured[0]!.strength).not.toBe(audioFavoured[0]!.strength)
  })
})

describe('selectNonOverlapping', () => {
  it('keeps the strongest of overlapping windows', () => {
    const items = [
      { window: { start: 0, end: 30 }, strength: 1 },
      { window: { start: 20, end: 50 }, strength: 5 },
      { window: { start: 100, end: 130 }, strength: 2 }
    ]
    expect(selectNonOverlapping(items, 5).map((i) => i.strength)).toEqual([5, 2])
    expect(selectNonOverlapping(items, 1)).toHaveLength(1)
  })
})

describe('selectByQuality', () => {
  type Item = { window: Range; strength: number; chatZ: number; audioZ: number; rating?: number | null }
  function loud(strength: number, start: number, rating: number | null = null): Item {
    return { window: { start, end: start + 20 }, strength, chatZ: 0, audioZ: strength, rating }
  }
  function chatBacked(strength: number, start: number, rating: number | null = null): Item {
    return { window: { start, end: start + 20 }, strength, chatZ: strength, audioZ: 0, rating }
  }

  it('returns nothing for no candidates', () => {
    expect(selectByQuality([], 3, 10)).toEqual([])
  })

  it('never returns more than max', () => {
    const many = Array.from({ length: 30 }, (_, i) => chatBacked(5 + i, i * 100))
    expect(selectByQuality(many, 3, 10)).toHaveLength(10)
  })

  it('keeps at least min when that many candidates exist, even if all are weak', () => {
    const weak = [loud(3.01, 0), loud(3, 100), loud(3.02, 200)]
    expect(selectByQuality(weak, 3, 10)).toHaveLength(3)
  })

  it('keeps every chat-backed candidate regardless of the loud-only bar', () => {
    const items = [chatBacked(2, 0), chatBacked(2.1, 100), chatBacked(1.9, 200), loud(9, 400)]
    const chosen = selectByQuality(items, 3, 10)
    expect(chosen.filter((c) => c.chatZ > 0)).toHaveLength(3)
  })

  it('keeps a loud-only candidate that stands out from this stream\'s other loud ones, drops the merely-loud rest', () => {
    // A tight cluster of ordinary loud moments plus one clear outlier.
    const items = [
      ...Array.from({ length: 10 }, (_, i) => loud(3 + i * 0.02, i * 100)),
      loud(20, 2000) // far louder than anything else this stream produced
    ]
    const chosen = selectByQuality(items, 3, 20)
    expect(chosen.some((c) => c.strength === 20)).toBe(true)
    expect(chosen.length).toBeLessThan(items.length)
  })

  it('is unaffected by rating fields that are absent, matching plain Candidate objects', () => {
    // findCandidates/Candidate never carries a rating; the type only requires
    // it to be optional, and its absence must behave like null (no model).
    const items = [
      { window: { start: 0, end: 20 }, strength: 2, chatZ: 2, audioZ: 0 },
      { window: { start: 100, end: 120 }, strength: 3.13, chatZ: 0, audioZ: 6.42 }
    ]
    expect(selectByQuality(items, 3, 10)).toHaveLength(2)
  })

  it('drops a chat-backed candidate the model rates at or below LOW_RATING, overriding its usual free pass', () => {
    const items = [chatBacked(2, 0, LOW_RATING), chatBacked(2.1, 100, 8), chatBacked(1.9, 200, 8), chatBacked(2.2, 300, 8)]
    const chosen = selectByQuality(items, 3, 10)
    expect(chosen.some((c) => c.rating === LOW_RATING)).toBe(false)
    expect(chosen).toHaveLength(3)
  })

  it('drops a loud-only candidate the model rates at or below LOW_RATING even if its strength already cleared the bar', () => {
    // Three unrated outliers clear the bar on their own (so the MIN_CLIPS
    // floor is satisfied without it), plus a fourth, even stronger outlier
    // that the model rates at LOW_RATING.
    const items = [
      ...Array.from({ length: 10 }, (_, i) => loud(3 + i * 0.02, i * 100)),
      loud(12, 1200),
      loud(14, 1400),
      loud(16, 1600),
      loud(20, 2000, LOW_RATING)
    ]
    const chosen = selectByQuality(items, 3, 20)
    expect(chosen).toHaveLength(3)
    expect(chosen.some((c) => c.strength === 20)).toBe(false)
    expect(chosen.map((c) => c.strength).sort((a, b) => a - b)).toEqual([12, 14, 16])
  })

  it('the MIN_CLIPS floor overrides a low rating when there are not enough other candidates', () => {
    const items = [chatBacked(2, 0, LOW_RATING), chatBacked(2.1, 100, LOW_RATING), chatBacked(1.9, 200, LOW_RATING)]
    expect(selectByQuality(items, 3, 10)).toHaveLength(3)
  })

  it('lets a highly-rated loud-only candidate clear a bar it would otherwise fail (rating folded into strength by the caller)', () => {
    // Caller (steps.ts) scales strength by ratingFactor before calling in;
    // this checks selectByQuality actually uses that scaled strength for the
    // bar rather than some other field.
    const ordinary = Array.from({ length: 10 }, (_, i) => loud(3 + i * 0.02, i * 100, 6))
    const barelyAboveThreshold = loud(3.01, 5000, 9)
    const boosted = { ...barelyAboveThreshold, strength: barelyAboveThreshold.strength * 1.6 }
    const withoutBoost = selectByQuality([...ordinary, barelyAboveThreshold], 3, 20)
    const withBoost = selectByQuality([...ordinary, boosted], 3, 20)
    expect(withoutBoost.some((c) => c.window.start === 5000)).toBe(false)
    expect(withBoost.some((c) => c.window.start === 5000)).toBe(true)
  })
})

describe('fallbackTitle', () => {
  it('builds a readable title from the middle sentence', () => {
    const words: Word[] = 'I cannot believe he just did that. No way man.'.split(' ').map((text, i) => ({ t0: i, t1: i + 0.5, text }))
    const t = fallbackTitle(words, { start: 0, end: 10 })
    expect(t.length).toBeGreaterThan(3)
    expect(t.length).toBeLessThanOrEqual(60)
    expect(t[0]).toBe(t[0]!.toUpperCase())
  })
  it('has a default for silent clips', () => {
    expect(fallbackTitle([], { start: 0, end: 10 })).toBe('Untitled moment')
  })
})
