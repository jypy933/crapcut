import { describe, expect, it } from 'vitest'
import type { Clip } from '@shared/types'
import { buildBestOfArgs, keptClipsInOrder, planBestOfJoin, type BestOfClipInput } from './bestOf'

const clip = (duration: number, hasAudio = true, file = 'c.mp4'): BestOfClipInput => ({ file, duration, hasAudio })

/** A minimal fake Clip; only the fields keptClipsInOrder cares about vary per call. */
const fakeClip = (overrides: Partial<Clip> & { id: string }): Clip => ({
  jobId: 'job1',
  rank: 1,
  score: 0.5,
  title: overrides.id,
  start: 0,
  end: 30,
  suggested: { start: 0, end: 30 },
  source: null,
  status: 'accepted',
  words: [],
  captions: { enabled: true, y: 0.7, uppercase: true, styleId: 'clean' },
  audio: 'original',
  musicPath: null,
  layoutId: null,
  formats: { vertical: true, horizontal: false },
  reason: 'Chat spike',
  signals: null,
  ...overrides
})

describe('keptClipsInOrder', () => {
  it('sorts by start time, not by rank', () => {
    // rank 1 is the finder's favourite (highest score), not the first clip in
    // the stream -- the strongest moment here happens latest in the VOD.
    const late = fakeClip({ id: 'late', rank: 1, start: 500 })
    const early = fakeClip({ id: 'early', rank: 3, start: 10 })
    const middle = fakeClip({ id: 'middle', rank: 2, start: 200 })
    expect(keptClipsInOrder([late, early, middle]).map((c) => c.id)).toEqual(['early', 'middle', 'late'])
  })

  it('drops pending and rejected clips', () => {
    const kept = fakeClip({ id: 'kept', start: 10, status: 'accepted' })
    const rejected = fakeClip({ id: 'rejected', start: 5, status: 'rejected' })
    const pending = fakeClip({ id: 'pending', start: 1, status: 'pending' })
    expect(keptClipsInOrder([kept, rejected, pending]).map((c) => c.id)).toEqual(['kept'])
  })

  it('does not mutate the input array', () => {
    const list = [fakeClip({ id: 'b', start: 20 }), fakeClip({ id: 'a', start: 10 })]
    const copy = [...list]
    keptClipsInOrder(list)
    expect(list).toEqual(copy)
  })
})

describe('planBestOfJoin', () => {
  it('has no transitions for zero or one clip', () => {
    expect(planBestOfJoin([], 0.5)).toEqual({ transitions: [], totalDurationSec: 0 })
    expect(planBestOfJoin([clip(10)], 0.5)).toEqual({ transitions: [], totalDurationSec: 10 })
  })

  it('overlaps each transition by the crossfade and shortens the total', () => {
    const plan = planBestOfJoin([clip(10), clip(8), clip(12)], 0.5)
    expect(plan.transitions).toHaveLength(2)
    expect(plan.transitions[0]).toEqual({ crossfadeSec: 0.5, offsetSec: 9.5 })
    expect(plan.transitions[1]!.crossfadeSec).toBe(0.5)
    // 10 + 8 + 12 - 0.5 - 0.5
    expect(plan.totalDurationSec).toBeCloseTo(29, 5)
  })

  it('clamps the crossfade for a clip shorter than the default', () => {
    const plan = planBestOfJoin([clip(10), clip(1)], 0.5)
    // 40% of the 1s clip is the binding constraint.
    expect(plan.transitions[0]!.crossfadeSec).toBeCloseTo(0.4, 5)
  })

  it('falls back to a hard cut for a clip shorter than the crossfade floor', () => {
    const plan = planBestOfJoin([clip(10), clip(0.02)], 0.5)
    expect(plan.transitions[0]!.crossfadeSec).toBe(0)
    expect(plan.transitions[0]!.offsetSec).toBeCloseTo(10, 5)
    expect(plan.totalDurationSec).toBeCloseTo(10.02, 5)
  })
})

describe('buildBestOfArgs', () => {
  it('rejects an empty clip list', () => {
    expect(() => buildBestOfArgs([], { crossfadeSec: 0.5, encoder: 'libx264', output: 'out.mp4' })).toThrow()
  })

  it('re-encodes a single clip with no crossfade filter', () => {
    const args = buildBestOfArgs([clip(10)], { crossfadeSec: 0.5, encoder: 'libx264', output: 'out.mp4' })
    expect(args).toContain('-i')
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).not.toContain('xfade')
    expect(graph).not.toContain('acrossfade')
    expect(args).toContain('[v0]')
    expect(args).toContain('[a0]')
    expect(args[args.length - 1]).toBe('out.mp4')
  })

  it('chains xfade and acrossfade for several clips', () => {
    const args = buildBestOfArgs([clip(10), clip(8), clip(12)], { crossfadeSec: 0.5, encoder: 'libx264', output: 'out.mp4' })
    expect(args.filter((a) => a === '-i')).toHaveLength(3)
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph.match(/xfade=/g)).toHaveLength(2)
    expect(graph.match(/acrossfade=/g)).toHaveLength(2)
    expect(graph).toContain('offset=9.500')
    expect(args).toContain('[vx2]')
    expect(args).toContain('[ax2]')
  })

  it('normalises size, frame rate and audio format for every input', () => {
    const graph = buildBestOfArgs([clip(10), clip(8)], { crossfadeSec: 0.5, encoder: 'libx264', output: 'out.mp4' })[
      buildBestOfArgs([clip(10), clip(8)], { crossfadeSec: 0.5, encoder: 'libx264', output: 'out.mp4' }).indexOf('-filter_complex') + 1
    ]!
    expect(graph).toContain('scale=1920:1080')
    expect(graph).toContain(`fps=30`)
    expect(graph).toContain('aresample=48000')
  })

  it('fills in silence for a clip with no audio track', () => {
    const args = buildBestOfArgs([clip(10, true), clip(8, false)], { crossfadeSec: 0.5, encoder: 'libx264', output: 'out.mp4' })
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('anullsrc=r=48000:cl=stereo')
    expect(args).toContain('[ax1]')
  })

  it('drops audio entirely when no clip has any', () => {
    const args = buildBestOfArgs([clip(10, false), clip(8, false)], { crossfadeSec: 0.5, encoder: 'libx264', output: 'out.mp4' })
    expect(args).toContain('-an')
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).not.toContain('anullsrc')
    expect(graph).not.toContain('acrossfade')
  })

  it('uses the chosen encoder', () => {
    const args = buildBestOfArgs([clip(10)], { crossfadeSec: 0.5, encoder: 'h264_nvenc', output: 'out.mp4' })
    expect(args).toContain('h264_nvenc')
  })
})
