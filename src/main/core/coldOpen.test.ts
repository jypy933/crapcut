import { describe, expect, it } from 'vitest'
import type { Word } from '@shared/types'
import { planColdOpen, previewSpan, repeatsWordWithin, type ColdOpenInputs } from './coldOpen'
import type { Envelope } from './editRules'

/** A 0.3 s word every `gap` seconds from `from` to `to`. */
function speech(from: number, to: number, gap = 0.5): Word[] {
  const out: Word[] = []
  for (let t = from; t < to; t += gap) out.push({ t0: t, t1: t + 0.3, text: `w${out.length}` })
  return out
}

/** A 0.1 s envelope of `total` seconds at `base` dB with one loud burst. */
function envelope(total: number, base: number, burst: { from: number; to: number; db: number }): Envelope {
  const db = new Array<number>(total * 10).fill(base)
  for (let i = burst.from * 10; i < burst.to * 10; i++) db[i] = burst.db
  return { startSec: 0, stepSec: 0.1, db }
}

const straight = (end = 40) => [{ srcStart: 0, srcEnd: end, speed: 1 }]

/** A clip that should qualify: 40 s, payoff at 20 s, a chat peak at 27 s (7 s of chat lag), a 30 dB loudness lift, plenty of words. */
function inputs(over: Partial<ColdOpenInputs> = {}): ColdOpenInputs {
  return {
    words: speech(0, 40),
    segments: straight(),
    peakSec: 20,
    chatPeak: { sec: 27, weight: 8 },
    env: envelope(40, -45, { from: 20, to: 23, db: -12 }),
    llm: 'unavailable',
    payoffVodSec: 1020,
    ...over
  }
}

describe('previewSpan', () => {
  it('starts on a word boundary just before the payoff and ends on a word boundary, 1.5-3 s long', () => {
    const words = speech(0, 40)
    const span = previewSpan(words, 20, 40)!
    expect(span).not.toBeNull()
    const len = span.srcEnd - span.srcStart
    expect(len).toBeGreaterThanOrEqual(1.5)
    expect(len).toBeLessThanOrEqual(3 + 0.2)
    // Neither edge lands inside a word.
    for (const w of words) {
      expect(span.srcStart > w.t0 && span.srcStart < w.t1).toBe(false)
      expect(span.srcEnd > w.t0 && span.srcEnd < w.t1).toBe(false)
    }
    expect(span.srcStart).toBeLessThan(20)
    expect(span.srcEnd).toBeGreaterThan(20)
  })

  it('is at most 4 s and at most a fifth of the clip', () => {
    expect(previewSpan(speech(0, 40), 20, 40)!.srcEnd - previewSpan(speech(0, 40), 20, 40)!.srcStart).toBeLessThanOrEqual(4)
    // A 30 s edit allows 6 s by share, but the 4 s cap holds; a 6 s edit allows only 1.2 s, under the 1.5 s minimum.
    expect(previewSpan(speech(0, 6), 3, 6)).toBeNull()
  })

  it('gives up rather than cut through a long word', () => {
    const words: Word[] = [{ t0: 19, t1: 25, text: 'looooong' }]
    expect(previewSpan(words, 20, 60)).toBeNull()
  })
})

describe('repeatsWordWithin', () => {
  it('flags a source word shown twice within 2 s, and not one shown 8 s apart', () => {
    const words = speech(0, 12)
    const near = [{ srcStart: 3, srcEnd: 5, speed: 1 }, { srcStart: 0, srcEnd: 12, speed: 1 }]
    // A 1.5 s preview of the first words, then the whole clip: the first word plays again 1.5 s after it first played.
    expect(repeatsWordWithin([{ srcStart: 0, srcEnd: 1.5, speed: 1 }, { srcStart: 0, srcEnd: 12, speed: 1 }], words, 2)).toBe(true)
    // A preview from 3 s in comes back 5 s after it first played.
    expect(repeatsWordWithin(near, words, 2)).toBe(false)
    expect(repeatsWordWithin([{ srcStart: 0, srcEnd: 12, speed: 1 }], words, 2)).toBe(false)
  })
})

describe('planColdOpen', () => {
  it('qualifies when chat, loudness and words agree, with a preview segment first and the straight edit after', () => {
    const plan = planColdOpen(inputs())
    expect(plan.qualifies).toBe(true)
    expect(plan.confidence).toBeGreaterThan(0.9)
    expect(plan.previewSec).toBeGreaterThanOrEqual(1.5)
    expect(plan.previewSec).toBeLessThanOrEqual(4)
    expect(plan.previewSec).toBeLessThanOrEqual(0.2 * 40)
    expect(plan.segments.length).toBe(2)
    expect(plan.segments[0]!.srcStart).toBeLessThan(20)
    expect(plan.segments[0]!.srcEnd).toBeGreaterThan(20)
    expect(plan.segments[1]).toEqual({ srcStart: 0, srcEnd: 40 })
    expect(plan.finalSec).toBeCloseTo(40 + plan.previewSec, 6)
    expect(plan.capFit.tiktok.fits).toBe(true)
    expect(plan.payoffVodSec).toBe(1020)
  })

  it('counts the preview against the caps', () => {
    const plan = planColdOpen(inputs({ words: speech(0, 58), segments: straight(58), peakSec: 30, chatPeak: { sec: 37, weight: 8 }, env: envelope(58, -45, { from: 30, to: 33, db: -12 }) }))
    expect(plan.qualifies).toBe(true)
    expect(plan.finalSec).toBeGreaterThan(58)
    expect(plan.capFit.tiktok.fits).toBe(plan.finalSec <= 60)
    expect(plan.capFit.reels.fits).toBe(true)
  })

  it('skips a payoff in the first 3 s', () => {
    const plan = planColdOpen(inputs({ peakSec: 2, chatPeak: { sec: 9, weight: 8 }, env: envelope(40, -45, { from: 2, to: 5, db: -12 }) }))
    expect(plan.qualifies).toBe(false)
    expect(plan.reasons.join(' ')).toMatch(/first 3s/)
    expect(plan.segments).toEqual([])
    expect(plan.previewSec).toBe(0)
  })

  it('skips a payoff in the first 15% of the clip', () => {
    // 10 s of a 100 s edit is 10%: past 3 s, under 15%.
    const plan = planColdOpen(inputs({ words: speech(0, 100), segments: straight(100), peakSec: 10, chatPeak: { sec: 17, weight: 8 }, env: envelope(100, -45, { from: 10, to: 13, db: -12 }) }))
    expect(plan.qualifies).toBe(false)
    expect(plan.reasons.join(' ')).toMatch(/first 15%/)
  })

  it('needs a setup of at least 8 s', () => {
    const plan = planColdOpen(inputs({ words: speech(0, 20), segments: straight(20), peakSec: 7, chatPeak: { sec: 14, weight: 8 }, env: envelope(20, -45, { from: 7, to: 10, db: -12 }) }))
    expect(plan.qualifies).toBe(false)
    expect(plan.reasons.join(' ')).toMatch(/under 8s/)
    expect(planColdOpen(inputs({ words: speech(0, 20), segments: straight(20), peakSec: 8.5, chatPeak: { sec: 15.5, weight: 8 }, env: envelope(20, -45, { from: 8, to: 11, db: -12 }) })).qualifies).toBe(true)
  })

  it('needs all three signals: chat, loudness and words', () => {
    expect(planColdOpen(inputs({ chatPeak: null })).qualifies).toBe(false)
    expect(planColdOpen(inputs({ chatPeak: { sec: 27, weight: 1 } })).qualifies).toBe(false)
    expect(planColdOpen(inputs({ env: null })).qualifies).toBe(false)
    expect(planColdOpen(inputs({ env: envelope(40, -45, { from: 20, to: 23, db: -42 }) })).qualifies).toBe(false)
    expect(planColdOpen(inputs({ words: speech(0, 18).concat(speech(30, 40)) })).qualifies).toBe(false)
  })

  it('needs the chat peak to sit where the payoff lands, allowing for chat lag', () => {
    expect(planColdOpen(inputs({ chatPeak: { sec: 27, weight: 8 } })).qualifies).toBe(true)
    expect(planColdOpen(inputs({ chatPeak: { sec: 5, weight: 8 } })).qualifies).toBe(false)
    expect(planColdOpen(inputs({ chatPeak: { sec: 38, weight: 8 } })).qualifies).toBe(false)
  })

  it('is stricter without the language model than with it', () => {
    // Enough for the model-backed 0.55, not for the 0.7 without one.
    const weak: Partial<ColdOpenInputs> = { chatPeak: { sec: 27, weight: 3.6 }, env: envelope(40, -45, { from: 20, to: 23, db: -37 }) }
    const without = planColdOpen(inputs({ ...weak, llm: 'unavailable' }))
    const confirmed = planColdOpen(inputs({ ...weak, llm: 'confirmed' }))
    expect(without.confidence).toBeCloseTo(confirmed.confidence, 6)
    expect(without.confidence).toBeGreaterThan(0.55)
    expect(without.confidence).toBeLessThan(0.7)
    expect(without.qualifies).toBe(false)
    expect(confirmed.qualifies).toBe(true)
    expect(confirmed.llm).toBe('confirmed')
  })

  it('never qualifies when the model says no, however strong the signals', () => {
    const plan = planColdOpen(inputs({ llm: 'rejected' }))
    expect(plan.qualifies).toBe(false)
    expect(plan.confidence).toBeGreaterThan(0.9)
    expect(plan.reasons.join(' ')).toMatch(/language model/)
  })

  it('skips an empty edit', () => {
    expect(planColdOpen(inputs({ segments: [] })).qualifies).toBe(false)
  })
})
