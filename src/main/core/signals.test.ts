import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './chat'
import { chatterBurstSeries, distinctChatters, findPeaks, maxIn, movingAverage, reactionWeight, robustZ } from './signals'

/** Deterministic pseudo-random numbers so tests never flake. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function backgroundChat(duration: number, perSec: number, seed = 1): ChatMessage[] {
  const r = rng(seed)
  const out: ChatMessage[] = []
  for (let t = 0; t < duration; t++) {
    const n = Math.floor(perSec * 2 * r())
    for (let k = 0; k < n; k++) out.push({ t: t + r(), user: `u${Math.floor(r() * 5000)}`, text: 'hello there' })
  }
  return out
}

function burst(at: number, seconds: number, perSec: number, text: string, seed = 2): ChatMessage[] {
  const r = rng(seed)
  const out: ChatMessage[] = []
  for (let t = at; t < at + seconds; t++)
    for (let k = 0; k < perSec; k++) out.push({ t: t + r(), user: `b${seed}_${t}_${k}`, text })
  return out
}

describe('reactionWeight', () => {
  it('scores reactions above plain chat', () => {
    expect(reactionWeight('hello there')).toBe(1)
    expect(reactionWeight('KEKW')).toBeGreaterThan(1)
    expect(reactionWeight('Pog clip it')).toBeGreaterThan(1)
    expect(reactionWeight('???')).toBeGreaterThan(1)
    expect(reactionWeight('L')).toBeGreaterThan(1)
    expect(reactionWeight('no way')).toBeGreaterThan(1)
    expect(reactionWeight('KEKW POG WTF LETS GO')).toBeLessThanOrEqual(3)
  })
  it('does not treat ordinary words containing w or l as reactions', () => {
    expect(reactionWeight('well that was low')).toBe(1)
  })
})

describe('movingAverage', () => {
  it('averages a centred window', () => {
    const s = Float64Array.from([0, 0, 3, 0, 0])
    expect(Array.from(movingAverage(s, 3))).toEqual([0, 1, 1, 1, 0])
  })
})

describe('chatterBurstSeries', () => {
  it('grows with distinct chatters, not with one chatter repeating', () => {
    const oneChatter: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({ t: 100 + i, user: 'solo', text: 'KEKW' }))
    const fiveChatters: ChatMessage[] = Array.from({ length: 5 }, (_, i) => ({ t: 100 + i * 2, user: `u${i}`, text: 'KEKW' }))
    const w = reactionWeight('KEKW')
    expect(Math.max(...chatterBurstSeries(oneChatter, 300))).toBeCloseTo(w, 6)
    expect(Math.max(...chatterBurstSeries(fiveChatters, 300))).toBeCloseTo(5 * w, 6)
  })

  it('only counts messages within the rolling window', () => {
    const s = chatterBurstSeries([{ t: 100, user: 'a', text: 'KEKW' }], 300, 20)
    expect(s[89]).toBe(0)
    expect(s[90]).toBeGreaterThan(0)
    expect(s[110]).toBeGreaterThan(0)
    expect(s[111]).toBe(0)
  })

  it('is empty for no messages', () => {
    expect(Array.from(chatterBurstSeries([], 60))).toEqual(new Array(60).fill(0))
  })
})

describe('distinctChatters', () => {
  it('counts unique users in range, case-insensitively, ignoring ones outside it', () => {
    const messages: ChatMessage[] = [
      { t: 10, user: 'Alice', text: 'hi' },
      { t: 12, user: 'alice', text: 'hi again' },
      { t: 15, user: 'Bob', text: 'yo' },
      { t: 50, user: 'Carol', text: 'late' }
    ]
    expect(distinctChatters(messages, 0, 20)).toBe(2)
    expect(distinctChatters(messages, 0, 60)).toBe(3)
  })
})

describe('chat spikes end to end', () => {
  const duration = 3600
  const msgs = [...backgroundChat(duration, 2), ...burst(1800, 12, 25, 'KEKW'), ...burst(600, 8, 15, 'Pog', 3)]
  msgs.sort((a, b) => a.t - b.t)
  const z = robustZ(chatterBurstSeries(msgs, duration), 600, 2)
  const peaks = findPeaks(z, 3, 60)

  it('finds both bursts, strongest first', () => {
    expect(peaks.length).toBeGreaterThanOrEqual(2)
    expect(peaks[0]!.t).toBeGreaterThanOrEqual(1790)
    expect(peaks[0]!.t).toBeLessThanOrEqual(1820)
    expect(peaks.some((p) => p.t >= 590 && p.t <= 620)).toBe(true)
  })

  it('does not report background noise', () => {
    expect(peaks.every((p) => (p.t > 580 && p.t < 630) || (p.t > 1780 && p.t < 1830))).toBe(true)
  })

  it('ignores one user spamming', () => {
    const spam: ChatMessage[] = Array.from({ length: 300 }, (_, i) => ({ t: 1200 + i / 30, user: 'spammer', text: 'KEKW KEKW' }))
    const all = [...backgroundChat(duration, 2), ...spam].sort((a, b) => a.t - b.t)
    const z2 = robustZ(chatterBurstSeries(all, duration), 600, 2)
    expect(findPeaks(z2, 3, 60).filter((p) => p.t > 1190 && p.t < 1215)).toHaveLength(0)
  })

  it('stays quiet on a dead chat', () => {
    const z3 = robustZ(chatterBurstSeries([], 600), 600, 2)
    expect(findPeaks(z3, 3, 60)).toHaveLength(0)
  })

  it('a handful of different chatters registers in a small chat but not in a big fast one', () => {
    const fewRegulars: ChatMessage[] = Array.from({ length: 4 }, (_, i) => ({ t: 300 + i * 2, user: `reg${i}`, text: 'KEKW' }))
    const smallChat = [...backgroundChat(duration, 0.02), ...fewRegulars].sort((a, b) => a.t - b.t)
    const bigChat = [...backgroundChat(duration, 20, 9), ...fewRegulars].sort((a, b) => a.t - b.t)
    const smallPeaks = findPeaks(robustZ(chatterBurstSeries(smallChat, duration), 600, 2), 2.5, 60)
    const bigPeaks = findPeaks(robustZ(chatterBurstSeries(bigChat, duration), 600, 2), 2.5, 60)
    expect(smallPeaks.some((p) => p.t > 290 && p.t < 320)).toBe(true)
    expect(bigPeaks.some((p) => p.t > 290 && p.t < 320)).toBe(false)
  })
})

describe('maxIn', () => {
  it('clamps the range', () => {
    const s = Float64Array.from([1, 5, 2])
    expect(maxIn(s, -10, 10)).toBe(5)
    expect(maxIn(s, 2, 2)).toBe(2)
  })
})
