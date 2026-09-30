import { describe, expect, it } from 'vitest'
import type { Word } from '@shared/types'
import type { Envelope } from './editRules'
import {
  buildFrameGrabArgs,
  checkLoop,
  frameSimilarity,
  planLoopEnd,
  seamCrossfadeSec,
  seamLoudnessDiff,
  seamPasses,
  windowLevelDb,
  type LoopCandidateInputs
} from './loopSeam'

/** A 0.3 s word every 0.5 s from 0 to `to`. */
function speech(to: number): Word[] {
  const out: Word[] = []
  for (let t = 0; t < to; t += 0.5) out.push({ t0: t, t1: t + 0.3, text: 'blah' })
  return out
}

const fine = (total: number, base: number, spans: { from: number; to: number; db: number }[] = []): Envelope => {
  const db = new Array<number>(Math.round(total * 10)).fill(base)
  for (const s of spans) for (let i = Math.round(s.from * 10); i < Math.round(s.to * 10); i++) db[i] = s.db
  return { startSec: 0, stepSec: 0.1, db }
}

/** 20 s of speech at -20 dB over a -50 dB bed; the last word ends at 19.8. */
function inputs(over: Partial<LoopCandidateInputs> = {}): LoopCandidateInputs {
  const words = speech(20)
  const last = words[words.length - 1]!
  return { words, segments: [{ srcStart: 0, srcEnd: 22, speed: 1 }], clipLength: 22, peakSec: 10, env: fine(22, -50, [{ from: 0, to: last.t1 + 0.1, db: -20 }]), ...over }
}

describe('planLoopEnd', () => {
  it('ends on the last word plus its real end and 0.25 s of quiet', () => {
    const { candidate } = planLoopEnd(inputs())
    expect(candidate).not.toBeNull()
    // last word ends 19.8; whisper ends early by 0.1; 0.25 s of quiet after that.
    expect(candidate!.endSec).toBeCloseTo(19.8 + 0.1 + 0.25, 6)
    expect(candidate!.quietSec).toBeCloseTo(0.25, 6)
    expect(candidate!.quietMeasured).toBe(true)
    expect(candidate!.finalSec).toBeCloseTo(candidate!.endSec, 6)
  })

  it('uses less quiet when the audio only stays quiet that long, and none when it does not', () => {
    const last = speech(20).at(-1)!
    const short = planLoopEnd(inputs({ env: fine(22, -50, [{ from: 0, to: last.t1 + 0.1, db: -20 }, { from: last.t1 + 0.1 + 0.2, to: 22, db: -20 }]) }))
    expect(short.candidate!.quietSec).toBeCloseTo(0.2, 6)
    const none = planLoopEnd(inputs({ env: fine(22, -50, [{ from: 0, to: 22, db: -20 }]) }))
    expect(none.candidate).toBeNull()
    expect(none.reason).toMatch(/quiet/)
  })

  it('stays within 150-400 ms of quiet after the last word', () => {
    const c = planLoopEnd(inputs()).candidate!
    const quiet = c.endSec - (19.8 + 0.1)
    expect(quiet).toBeGreaterThanOrEqual(0.15)
    expect(quiet).toBeLessThanOrEqual(0.4)
  })

  it('assumes the target quiet without a fine envelope, marked as not measured', () => {
    const c = planLoopEnd(inputs({ env: null })).candidate!
    expect(c.quietMeasured).toBe(false)
    expect(c.quietSec).toBe(0.25)
  })

  it('is only for a final length of 30 s or less, and at least the floor', () => {
    const long = planLoopEnd(inputs({ words: speech(40), segments: [{ srcStart: 0, srcEnd: 42, speed: 1 }], clipLength: 42, env: null }))
    expect(long.candidate).toBeNull()
    expect(long.reason).toMatch(/over 30s/)
    const edge = planLoopEnd(inputs({ words: speech(29.4), segments: [{ srcStart: 0, srcEnd: 31, speed: 1 }], clipLength: 31, env: null }))
    expect(edge.candidate!.finalSec).toBeLessThanOrEqual(30)
    const tiny = planLoopEnd(inputs({ words: speech(5), segments: [{ srcStart: 0, srcEnd: 6, speed: 1 }], clipLength: 6, peakSec: 3, env: null }))
    expect(tiny.candidate).toBeNull()
    expect(tiny.reason).toMatch(/floor/)
  })

  it('never trims the reaction beat after the payoff, and needs words', () => {
    const late = planLoopEnd(inputs({ peakSec: 21, env: null }))
    expect(late.candidate).toBeNull()
    expect(late.reason).toMatch(/reaction/)
    expect(planLoopEnd(inputs({ words: [] })).candidate).toBeNull()
  })

  it('does not end past the clip', () => {
    expect(planLoopEnd(inputs({ clipLength: 19.9, segments: [{ srcStart: 0, srcEnd: 19.9, speed: 1 }], env: null })).candidate).toBeNull()
  })
})

describe('the seam', () => {
  it('scores 1 for identical frames and 0 at a mean difference of 64 grey levels', () => {
    const a = new Uint8Array(576).fill(100)
    expect(frameSimilarity(a, a)).toBe(1)
    expect(frameSimilarity(a, new Uint8Array(576).fill(164))).toBeCloseTo(0, 6)
    expect(frameSimilarity(a, new Uint8Array(576).fill(255))).toBe(0)
    expect(frameSimilarity(a, new Uint8Array(576).fill(129))).toBeCloseTo(1 - 29 / 64, 6)
    expect(frameSimilarity([], [])).toBe(0)
  })

  it('passes at a frame similarity of 0.55 and a loudness step of 3 LU', () => {
    expect(seamPasses({ frameSimilarity: 0.55, loudnessDiffLu: 3 })).toBe(true)
    expect(seamPasses({ frameSimilarity: 0.54, loudnessDiffLu: 1 })).toBe(false)
    expect(seamPasses({ frameSimilarity: 0.9, loudnessDiffLu: 3.1 })).toBe(false)
  })

  it('measures the level of 400 ms as a power mean', () => {
    const env = fine(10, -30, [{ from: 5, to: 5.2, db: -10 }])
    // Half of the 400 ms at -10 dB, half at -30: about -13 dB.
    expect(windowLevelDb(env, 5)!).toBeCloseTo(10 * Math.log10((10 ** -1 + 10 ** -3) / 2), 1)
    expect(windowLevelDb(env, 50)).toBeNull()
  })

  it('compares the first and last 400 ms of the looped edit', () => {
    const env = fine(10, -30, [{ from: 9.6, to: 10, db: -24 }])
    expect(seamLoudnessDiff(env, 0, 10)).toBeCloseTo(6, 1)
    expect(seamLoudnessDiff(env, 0, 100)).toBeNull()
    expect(seamLoudnessDiff(fine(10, -30), 0, 10)).toBeCloseTo(0, 6)
  })

  it('crossfades the audio for 30-100 ms, never more than a tenth of a short clip', () => {
    expect(seamCrossfadeSec(20)).toBeGreaterThanOrEqual(0.03)
    expect(seamCrossfadeSec(20)).toBeLessThanOrEqual(0.1)
    expect(seamCrossfadeSec(0.2)).toBeCloseTo(0.03, 6)
  })

  it('builds FFmpeg arguments as an array: whole frame, or the facecam area', () => {
    const whole = buildFrameGrabArgs('clip.mp4', 12.3456, null)
    expect(whole).toEqual(['-hide_banner', '-nostdin', '-v', 'error', '-ss', '12.346', '-i', 'clip.mp4', '-frames:v', '1', '-vf', 'scale=32:18:flags=area,format=gray', '-f', 'rawvideo', '-'])
    const cam = buildFrameGrabArgs('clip.mp4', -1, { x: 0.7, y: 0.6, w: 0.25, h: 0.3 })
    expect(cam).toContain('0.000')
    expect(cam[cam.indexOf('-vf') + 1]).toBe('crop=iw*0.2500:ih*0.3000:iw*0.7000:ih*0.6000,scale=32:32:flags=area,format=gray')
  })
})

describe('checkLoop', () => {
  const candidate = { endSec: 20, quietSec: 0.25, quietMeasured: true, finalSec: 20 }
  it('is n/a without a candidate and without a measurement, pass or fail once measured', () => {
    expect(checkLoop(null, 'no words to end on', null, true)).toMatchObject({ status: 'na', values: { eligible: false, why: 'no words to end on' } })
    expect(checkLoop(candidate, null, null, false).status).toBe('na')
    expect(checkLoop(candidate, null, { frameSimilarity: 0.8, loudnessDiffLu: 1 }, false)).toMatchObject({ status: 'pass', values: { eligible: true, uncalibrated: true } })
    expect(checkLoop(candidate, null, { frameSimilarity: 0.3, loudnessDiffLu: 1 }, true)).toMatchObject({ status: 'fail', values: { eligible: false, wanted: true } })
  })
})
