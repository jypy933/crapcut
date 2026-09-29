import { describe, expect, it } from 'vitest'
import type { Word } from './types'
import { belongsWithFollowing, DEFAULT_WORD_TIMING, isStretchedWord, maxPlausibleDuration, repairWordTimings } from './wordTiming'

function w(t0: number, t1: number, text: string): Word {
  return { t0, t1, text }
}

describe('maxPlausibleDuration', () => {
  it('scales with letters, with a floor and a cap', () => {
    expect(maxPlausibleDuration('I')).toBe(DEFAULT_WORD_TIMING.minDuration)
    expect(maxPlausibleDuration('a')).toBeCloseTo(DEFAULT_WORD_TIMING.minDuration, 5)
    expect(maxPlausibleDuration('extraordinary')).toBe(DEFAULT_WORD_TIMING.maxDuration)
    const mid = maxPlausibleDuration('mind')
    expect(mid).toBeGreaterThan(DEFAULT_WORD_TIMING.minDuration)
    expect(mid).toBeLessThan(DEFAULT_WORD_TIMING.maxDuration)
  })
})

describe('isStretchedWord', () => {
  it('flags a word far longer than its text plausibly takes', () => {
    expect(isStretchedWord(w(0, 0.2, 'hi'))).toBe(false)
    expect(isStretchedWord(w(0, 12, 'hi'))).toBe(true)
  })
})

describe('repairWordTimings on real examples', () => {
  // From a real 6-hour transcript: "Mind" swallowed the silence before it
  // because "surprise!" ends a sentence, so it belongs with what follows.
  it('pulls a word that starts a new sentence forward to its real end', () => {
    const words = [w(385.92, 386.71, 'surprise!'), w(386.71, 398.64, 'Mind'), w(398.64, 398.72, 'me')]
    const fixed = repairWordTimings(words)
    expect(fixed[0]).toEqual(words[0])
    expect(fixed[1]!.t1).toBe(398.64)
    expect(fixed[1]!.t0).toBeGreaterThan(397)
    expect(fixed[1]!.t0).toBeLessThanOrEqual(398.64)
    expect(fixed[2]).toEqual(words[2])
  })

  it('shrinks a mid-sentence word from its real start, pulling the end in', () => {
    const words = [w(755.25, 755.25, 'what'), w(755.25, 775.73, 'then?'), w(775.73, 775.73, 'I')]
    const fixed = repairWordTimings(words)
    expect(fixed[1]!.t0).toBe(755.25)
    expect(fixed[1]!.t1).toBeLessThan(757)
    expect(fixed[1]!.t1).toBeGreaterThan(755.25)
  })

  it('keeps a sentence-ending word at its start and pulls the tail in', () => {
    const words = [w(832.21, 832.21, 'that'), w(832.21, 849.65, 'earlier.'), w(849.65, 855.02, 'Things')]
    const fixed = repairWordTimings(words)
    expect(fixed[1]!.t0).toBe(832.21)
    expect(fixed[1]!.t1).toBeLessThan(834)
    // "Things" starts a new sentence after "earlier.", so it belongs with
    // what follows it, not what precedes it.
    expect(fixed[2]!.t1).toBe(855.02)
    expect(fixed[2]!.t0).toBeGreaterThan(853)
  })

  it('moves a capitalised word after a real pause forward, even with no punctuation', () => {
    const words = [w(940, 943.9, 'okay'), w(944.08, 978.53, "I'm"), w(978.53, 978.7, 'not')]
    const fixed = repairWordTimings(words)
    expect(fixed[1]!.t1).toBe(978.53)
    expect(fixed[1]!.t0).toBeGreaterThan(977)
  })

  it('leaves a short gap after a lowercase word alone (mid-sentence default)', () => {
    // No sentence end before it and no real pause: stays anchored to its start.
    const words = [w(1081, 1081.3, 'the'), w(1081.35, 1111.73, 'sauce')]
    const fixed = repairWordTimings(words)
    expect(fixed[1]!.t0).toBe(1081.35)
    expect(fixed[1]!.t1).toBeLessThan(1083)
  })
})

describe('repairWordTimings general behaviour', () => {
  it('is idempotent: repairing already-repaired words changes nothing', () => {
    const words = [w(386.71, 398.64, 'Mind'), w(398.64, 398.72, 'me')]
    const once = repairWordTimings(words)
    const twice = repairWordTimings(once)
    expect(twice).toEqual(once)
  })

  it('leaves plausible timings untouched', () => {
    const words = [w(0, 0.2, 'hi'), w(0.25, 0.7, 'there'), w(0.75, 1.3, 'friend.')]
    expect(repairWordTimings(words)).toEqual(words)
  })

  it('never produces an inverted or overlapping-with-previous word', () => {
    const words = [w(10, 10.2, 'a.'), w(10.2, 55, 'B')]
    const fixed = repairWordTimings(words)
    expect(fixed[1]!.t0).toBeGreaterThanOrEqual(fixed[0]!.t1)
    expect(fixed[1]!.t0).toBeLessThanOrEqual(fixed[1]!.t1)
  })
})

describe('belongsWithFollowing', () => {
  it('has no previous word to compare against', () => {
    expect(belongsWithFollowing(w(0, 5, 'Hi'), null)).toBe(false)
  })
})
