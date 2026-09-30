import { describe, expect, it } from 'vitest'
import {
  concatDuration,
  concatToOutputTime,
  freezeTotal,
  mapSourceTimeToConcat,
  outputDuration,
  segmentDuration,
  segmentStarts,
  sourceToOutputTime,
  validateEdl,
  type Edl,
  type EdlSegment
} from './edl'

const seg = (srcStart: number, srcEnd: number, speed = 1): EdlSegment => ({ srcStart, srcEnd, speed })

const baseEdl = (over: Partial<Edl> = {}): Edl => ({
  segments: [seg(0, 5)],
  zoom: [],
  freeze: [],
  overlays: [],
  sfx: [],
  ending: { kind: 'cut' },
  ...over
})

describe('segmentDuration', () => {
  it('is the source span at normal speed', () => {
    expect(segmentDuration(seg(10, 15))).toBe(5)
  })
  it('shrinks for a sped-up segment and grows for a slow one', () => {
    expect(segmentDuration(seg(0, 10, 2))).toBe(5)
    expect(segmentDuration(seg(0, 10, 0.5))).toBe(20)
  })
})

describe('segmentStarts / concatDuration', () => {
  it('lays segments end to end on the concat timeline', () => {
    const segments = [seg(0, 5), seg(20, 22, 2), seg(30, 40)]
    expect(segmentStarts(segments)).toEqual([0, 5, 6])
    expect(concatDuration(segments)).toBe(16)
  })
})

describe('freezeTotal / outputDuration', () => {
  it('adds every freeze hold on top of the concat duration', () => {
    const edl = baseEdl({ segments: [seg(0, 10)], freeze: [{ atOutputT: 2, holdSec: 1 }, { atOutputT: 5, holdSec: 0.5 }] })
    expect(freezeTotal(edl.freeze)).toBeCloseTo(1.5, 6)
    expect(outputDuration(edl)).toBeCloseTo(11.5, 6)
  })

  it('a loop ending adds nothing: the seam is a hard cut with an audio fade', () => {
    const edl = baseEdl({ segments: [seg(0, 10)], ending: { kind: 'loop', crossfadeSec: 0.06 } })
    expect(outputDuration(edl)).toBeCloseTo(10, 6)
  })

  it('a cut ending adds nothing', () => {
    expect(outputDuration(baseEdl({ segments: [seg(0, 10)] }))).toBe(10)
  })
})

describe('concatToOutputTime', () => {
  it('shifts by every freeze at or before the point', () => {
    const freeze = [{ atOutputT: 2, holdSec: 1 }, { atOutputT: 5, holdSec: 0.5 }]
    expect(concatToOutputTime(freeze, 1)).toBeCloseTo(1, 6)
    expect(concatToOutputTime(freeze, 2)).toBeCloseTo(3, 6)
    expect(concatToOutputTime(freeze, 4)).toBeCloseTo(5, 6)
    expect(concatToOutputTime(freeze, 6)).toBeCloseTo(7.5, 6)
  })
})

describe('mapSourceTimeToConcat', () => {
  it('maps a point inside a single segment', () => {
    expect(mapSourceTimeToConcat([seg(10, 20)], 15)).toEqual([5])
  })

  it('scales by speed', () => {
    expect(mapSourceTimeToConcat([seg(10, 20, 2)], 14)).toEqual([2])
  })

  it('returns one entry per use of a reused segment (cold open then full play)', () => {
    const segments = [seg(10, 12), seg(0, 20)]
    // 10..12 appears both as the cold open (segment 0) and inside the full play (segment 1).
    const result = mapSourceTimeToConcat(segments, 11)
    expect(result).toHaveLength(2)
    expect(result[0]).toBeCloseTo(1, 6)
    expect(result[1]).toBeCloseTo(2 + 11, 6)
  })

  it('is empty for a point outside every segment', () => {
    expect(mapSourceTimeToConcat([seg(10, 20)], 5)).toEqual([])
  })
})

describe('validateEdl', () => {
  it('accepts a simple valid edit', () => {
    expect(validateEdl(baseEdl(), 30)).toEqual([])
  })

  it('flags an empty edit', () => {
    expect(validateEdl(baseEdl({ segments: [] }), 30).length).toBeGreaterThan(0)
  })

  it('flags an empty or reversed segment', () => {
    expect(validateEdl(baseEdl({ segments: [seg(5, 5)] }), 30).length).toBeGreaterThan(0)
    expect(validateEdl(baseEdl({ segments: [seg(5, 2)] }), 30).length).toBeGreaterThan(0)
  })

  it('flags a segment outside the source', () => {
    expect(validateEdl(baseEdl({ segments: [seg(-1, 5)] }), 30).length).toBeGreaterThan(0)
    expect(validateEdl(baseEdl({ segments: [seg(0, 31)] }), 30).length).toBeGreaterThan(0)
  })

  it('flags a non-positive speed', () => {
    expect(validateEdl(baseEdl({ segments: [seg(0, 5, 0)] }), 30).length).toBeGreaterThan(0)
  })

  it('allows two segments to reuse the same source range', () => {
    expect(validateEdl(baseEdl({ segments: [seg(0, 5), seg(0, 10)] }), 30)).toEqual([])
  })

  it('flags two freezes at the same spot, and a non-positive hold', () => {
    expect(validateEdl(baseEdl({ segments: [seg(0, 10)], freeze: [{ atOutputT: 2, holdSec: 1 }, { atOutputT: 2, holdSec: 1 }] }), 30).length).toBeGreaterThan(0)
    expect(validateEdl(baseEdl({ segments: [seg(0, 10)], freeze: [{ atOutputT: 2, holdSec: 0 }] }), 30).length).toBeGreaterThan(0)
  })

  it('flags an overlay outside the output or with an empty range or no text', () => {
    expect(validateEdl(baseEdl({ overlays: [{ kind: 'quoteBar', t0: 1, t1: 1, text: 'hi', pos: { x: 0.5, y: 0.5, align: 'center' } }] }), 30).length).toBeGreaterThan(0)
    expect(validateEdl(baseEdl({ overlays: [{ kind: 'quoteBar', t0: 1, t1: 2, text: '  ', pos: { x: 0.5, y: 0.5, align: 'center' } }] }), 30).length).toBeGreaterThan(0)
    expect(validateEdl(baseEdl({ segments: [seg(0, 5)], overlays: [{ kind: 'quoteBar', t0: 1, t1: 10, text: 'hi', pos: { x: 0.5, y: 0.5, align: 'center' } }] }), 30).length).toBeGreaterThan(0)
  })

  it('flags a zoom keyframe or sfx cue outside the output', () => {
    expect(validateEdl(baseEdl({ segments: [seg(0, 5)], zoom: [{ t: 10, scale: 1.2, ease: 'snap' }] }), 30).length).toBeGreaterThan(0)
    expect(validateEdl(baseEdl({ segments: [seg(0, 5)], sfx: [{ t: 10, file: 'x.wav', gainDb: 0 }] }), 30).length).toBeGreaterThan(0)
  })

  it('flags a loop ending without a usable crossfade', () => {
    expect(validateEdl(baseEdl({ ending: { kind: 'loop', crossfadeSec: 0 } }), 30).length).toBeGreaterThan(0)
    expect(validateEdl(baseEdl({ segments: [seg(0, 0.05)], ending: { kind: 'loop', crossfadeSec: 0.06 } }), 30).length).toBeGreaterThan(0)
    expect(validateEdl(baseEdl({ ending: { kind: 'loop', crossfadeSec: 0.06 } }), 30)).toEqual([])
  })
})

describe('sourceToOutputTime', () => {
  it('lands a source second on the output timeline, after freezes', () => {
    expect(sourceToOutputTime([seg(2, 10)], [{ atOutputT: 1, holdSec: 0.5 }], 5, false)).toBeCloseTo(3.5, 6)
  })

  it('picks the first or the last use of a reused segment', () => {
    const segs = [seg(4, 6), seg(0, 10)]
    expect(sourceToOutputTime(segs, [], 5, false)).toBeCloseTo(1, 6)
    expect(sourceToOutputTime(segs, [], 5, true)).toBeCloseTo(7, 6)
  })

  it('clamps a second inside a trimmed gap to the nearest kept moment', () => {
    expect(sourceToOutputTime([seg(0, 2), seg(5, 8)], [], 3, false)).toBeCloseTo(2, 6)
  })
})
