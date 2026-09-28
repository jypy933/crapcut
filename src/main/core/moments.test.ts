import { describe, expect, it } from 'vitest'
import type { Word } from '@shared/types'
import type { ChatMessage } from './chat'
import {
  CLIP_MAX_SEC,
  CLIP_MIN_SEC,
  fallbackTitle,
  findCandidates,
  selectNonOverlapping,
  snapWindow,
  strengthToScore,
  targetClipCount
} from './moments'

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

describe('targetClipCount', () => {
  it('scales with duration within limits', () => {
    expect(targetClipCount(600)).toBe(3)
    expect(targetClipCount(4 * 3600)).toBe(12)
    expect(targetClipCount(20 * 3600)).toBe(20)
  })
})

describe('strengthToScore', () => {
  it('is monotonic in 0..1', () => {
    expect(strengthToScore(-1)).toBe(0)
    expect(strengthToScore(3)).toBeLessThan(strengthToScore(9))
    expect(strengthToScore(1000)).toBeLessThanOrEqual(1)
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
