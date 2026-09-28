import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './chat'
import { chatSeries, findPeaks, maxIn, movingAverage, reactionWeight, robustZ } from './signals'

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
    expect(reactionWeight('KEKW POG WTF LETS GO')).toBeLessThanOrEqual(3)
  })
})

describe('movingAverage', () => {
  it('averages a centred window', () => {
    const s = Float64Array.from([0, 0, 3, 0, 0])
    expect(Array.from(movingAverage(s, 3))).toEqual([0, 1, 1, 1, 0])
  })
})

describe('chat spikes', () => {
  const duration = 3600
  const msgs = [...backgroundChat(duration, 2), ...burst(1800, 12, 25, 'KEKW'), ...burst(600, 8, 15, 'Pog', 3)]
  msgs.sort((a, b) => a.t - b.t)
  const z = robustZ(movingAverage(chatSeries(msgs, duration), 8))
  const peaks = findPeaks(z, 3, 60)

  it('finds both bursts, strongest first', () => {
    expect(peaks.length).toBeGreaterThanOrEqual(2)
    expect(peaks[0]!.t).toBeGreaterThanOrEqual(1795)
    expect(peaks[0]!.t).toBeLessThanOrEqual(1815)
    expect(peaks.some((p) => p.t >= 595 && p.t <= 612)).toBe(true)
  })

  it('places the onset at the start of the rise', () => {
    expect(peaks[0]!.onset).toBeGreaterThanOrEqual(1790)
    expect(peaks[0]!.onset).toBeLessThanOrEqual(1802)
  })

  it('does not report background noise', () => {
    expect(peaks.every((p) => (p.t > 590 && p.t < 620) || (p.t > 1790 && p.t < 1820))).toBe(true)
  })

  it('ignores one user spamming', () => {
    const spam: ChatMessage[] = Array.from({ length: 300 }, (_, i) => ({ t: 1200 + i / 30, user: 'spammer', text: 'KEKW KEKW' }))
    const all = [...backgroundChat(duration, 2), ...spam].sort((a, b) => a.t - b.t)
    const z2 = robustZ(movingAverage(chatSeries(all, duration), 8))
    expect(findPeaks(z2, 3, 60).filter((p) => p.t > 1190 && p.t < 1215)).toHaveLength(0)
  })

  it('stays quiet on a dead chat', () => {
    const z3 = robustZ(movingAverage(chatSeries([], 600), 8))
    expect(findPeaks(z3, 3, 60)).toHaveLength(0)
  })
})

describe('maxIn', () => {
  it('clamps the range', () => {
    const s = Float64Array.from([1, 5, 2])
    expect(maxIn(s, -10, 10)).toBe(5)
    expect(maxIn(s, 2, 2)).toBe(2)
  })
})
