import { describe, expect, it } from 'vitest'
import type { Word } from '@shared/types'
import type { Edl, EdlSegment } from './edl'
import { remapWordsToEdl } from './edlCaptions'

const seg = (srcStart: number, srcEnd: number, speed = 1): EdlSegment => ({ srcStart, srcEnd, speed })

const baseEdl = (over: Partial<Edl> = {}): Edl => ({
  segments: [seg(0, 10)],
  zoom: [],
  freeze: [],
  overlays: [],
  sfx: [],
  ending: { kind: 'cut' },
  ...over
})

// Short, well-spaced words so `repairWordTimings` never touches them.
const w = (t0: number, t1: number, text: string): Word => ({ t0, t1, text })

describe('remapWordsToEdl', () => {
  it('drops words outside every segment', () => {
    const words = [w(0, 0.4, 'before'), w(5, 5.4, 'kept'), w(20, 20.4, 'after')]
    const out = remapWordsToEdl(words, baseEdl({ segments: [seg(4, 6)] }))
    expect(out.map((o) => o.text)).toEqual(['kept'])
  })

  it('shifts a word into a segment reordered later in the output', () => {
    const words = [w(10, 10.4, 'first'), w(0, 0.4, 'second')]
    const out = remapWordsToEdl(words, baseEdl({ segments: [seg(0, 1), seg(10, 11)] }))
    // segment 0 covers source [0,1) -> output [0,1); segment 1 covers [10,11) -> output [1,2).
    expect(out.map((o) => o.text)).toEqual(['second', 'first'])
    expect(out[0]!.t0).toBeCloseTo(0, 5)
    expect(out[1]!.t0).toBeCloseTo(1, 5)
  })

  it('clips a word straddling a segment boundary', () => {
    const words = [w(4.5, 5.5, 'straddle')]
    const out = remapWordsToEdl(words, baseEdl({ segments: [seg(0, 5)] }))
    expect(out).toHaveLength(1)
    expect(out[0]!.t0).toBeCloseTo(4.5, 5)
    expect(out[0]!.t1).toBeCloseTo(5, 5)
  })

  it('scales word timing by the segment speed', () => {
    // A short word (0.2s) so `repairWordTimings` -- checked against a
    // per-letter plausible-length floor -- leaves its timing alone.
    const words = [w(2, 2.2, 'fast')]
    const out = remapWordsToEdl(words, baseEdl({ segments: [seg(0, 10, 2)] }))
    expect(out[0]!.t0).toBeCloseTo(1, 5)
    expect(out[0]!.t1).toBeCloseTo(1.1, 5)
  })

  it('pushes words later by a freeze before them', () => {
    const words = [w(6, 6.4, 'after freeze')]
    const out = remapWordsToEdl(words, baseEdl({ segments: [seg(0, 10)], freeze: [{ atOutputT: 5, holdSec: 2 }] }))
    expect(out[0]!.t0).toBeCloseTo(8, 5)
  })

  it('repeats a word once per use of a reused segment (cold open then full play)', () => {
    const words = [w(10.2, 10.6, 'clutch')]
    const out = remapWordsToEdl(words, baseEdl({ segments: [seg(10, 11), seg(0, 20)] }))
    expect(out.map((o) => o.text)).toEqual(['clutch', 'clutch'])
    // First use: the cold open segment starts the output at 0.
    expect(out[0]!.t0).toBeCloseTo(0.2, 5)
    // Second use: inside the full play, which starts right after the cold open (duration 1).
    expect(out[1]!.t0).toBeCloseTo(1 + 10.2, 5)
  })

  it('drops a sliver of a word too short to keep', () => {
    const words = [w(4.999, 5.0005, 'sliver')]
    const out = remapWordsToEdl(words, baseEdl({ segments: [seg(0, 5)] }))
    expect(out).toHaveLength(0)
  })
})
