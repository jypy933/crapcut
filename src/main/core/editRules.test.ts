import { describe, expect, it } from 'vitest'
import type { Word } from '@shared/types'
import type { Edl } from './edl'
import {
  capFit,
  checkContent,
  checkHook,
  checkLength,
  checkPacing,
  contentCoverage,
  countChatPeaks,
  dbAt,
  EDIT_RULES,
  envelopeFromLoudness,
  envelopeFromSamples,
  firstEventSec,
  formatCheckLine,
  frameZeroIsContent,
  hookStartSec,
  isLoudGap,
  median,
  perSecondLoudness,
  medianDb,
  shiftEnvelope,
  speechFloorDb,
  type Envelope
} from './editRules'

const edl = (over: Partial<Edl> = {}): Edl => ({ segments: [{ srcStart: 0, srcEnd: 10, speed: 1 }], zoom: [], freeze: [], overlays: [], sfx: [], ending: { kind: 'cut' }, ...over })
const word = (t0: number, t1: number, text = 'x'): Word => ({ t0, t1, text })
const fine = (total: number, base: number, spans: { from: number; to: number; db: number }[] = []): Envelope => {
  const db = new Array<number>(Math.round(total * 10)).fill(base)
  for (const s of spans) for (let i = Math.round(s.from * 10); i < Math.round(s.to * 10); i++) db[i] = s.db
  return { startSec: 0, stepSec: 0.1, db }
}

describe('EDIT_RULES (the approved starting values)', () => {
  it('holds the numbers from the research table', () => {
    expect(EDIT_RULES.length.finalFloorSec).toBe(10)
    expect(EDIT_RULES.length.capSec).toEqual({ tiktok: 60, shorts: 60, reels: 90 })
    expect([EDIT_RULES.length.targetMinSec, EDIT_RULES.length.targetMaxSec]).toEqual([15, 45])
    expect(EDIT_RULES.content.minCoverage).toBe(0.4)
    expect([EDIT_RULES.hook.softSec, EDIT_RULES.hook.hardSec, EDIT_RULES.hook.trimOverSec, EDIT_RULES.hook.keepSec]).toEqual([0.5, 1.0, 0.3, 0.15])
    expect([EDIT_RULES.pacing.pauseSec, EDIT_RULES.pacing.loudGamePauseSec, EDIT_RULES.pacing.keepGapSec, EDIT_RULES.pacing.minSideSec]).toEqual([0.5, 0.7, 0.3, 0.15])
    expect([EDIT_RULES.coldOpen.setupMinSec, EDIT_RULES.coldOpen.previewMinSec, EDIT_RULES.coldOpen.previewMaxSec, EDIT_RULES.coldOpen.maxShareOfClip]).toEqual([8, 1.5, 4, 0.2])
    expect([EDIT_RULES.loop.maxFinalSec, EDIT_RULES.loop.quietMinSec, EDIT_RULES.loop.quietMaxSec, EDIT_RULES.loop.minFrameSimilarity, EDIT_RULES.loop.maxLoudnessDiffLu]).toEqual([30, 0.15, 0.4, 0.55, 3])
    expect([EDIT_RULES.loop.crossfadeMinSec, EDIT_RULES.loop.crossfadeMaxSec]).toEqual([0.03, 0.1])
  })
})

describe('envelopes', () => {
  it('turns the per-second loudness log into a one second envelope, or null with none', () => {
    expect(envelopeFromLoudness(null)).toBeNull()
    expect(envelopeFromLoudness(new Float64Array(0))).toBeNull()
    expect(envelopeFromLoudness(new Float64Array([-30, -20]), 5)).toEqual({ startSec: 5, stepSec: 1, db: [-30, -20] })
  })

  it('measures the level of each block of samples in dB, -100 for silence', () => {
    const rate = 8000
    const samples = new Float32Array(rate * 0.3)
    for (let i = 0; i < rate * 0.1; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / rate) // full-scale sine: mean square 0.5, about -3 dB
    const env = envelopeFromSamples(samples, rate, 0.1, 7)
    expect(env.db.length).toBe(3)
    expect(env.startSec).toBe(7)
    expect(env.db[0]!).toBeCloseTo(-3, 0)
    expect(env.db[1]).toBe(-100)
  })

  it('turns a fine envelope back into a per-second log with the same peak', () => {
    const env = fine(4, -50, [{ from: 2, to: 2.5, db: -10 }])
    const log = perSecondLoudness(env)
    expect(log.length).toBe(4)
    expect(log[0]).toBeCloseTo(-50, 6)
    expect(log[2]!).toBeCloseTo(10 * Math.log10((0.5 * 10 ** -1 + 0.5 * 10 ** -5)), 4)
    expect(Array.from(log).indexOf(Math.max(...log))).toBe(2)
  })

  it('reads the frame holding a second, and shifts the clock', () => {
    const env = fine(2, -30, [{ from: 1, to: 2, db: -10 }])
    expect(dbAt(env, 0.5)).toBe(-30)
    expect(dbAt(env, 1.5)).toBe(-10)
    expect(dbAt(env, 5)).toBeNull()
    expect(shiftEnvelope(env, 100)!.startSec).toBe(-100)
    expect(shiftEnvelope(null, 1)).toBeNull()
  })

  it('takes the median of the frames that are not near-silent', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([])).toBeNull()
    expect(medianDb(fine(2, -30, [{ from: 0, to: 1, db: -100 }]), 0, 2)).toBe(-30)
    expect(medianDb(null, 0, 1)).toBeNull()
  })

  it('finds the speech level (minus a margin) only on a fine envelope', () => {
    const words = [word(0, 1), word(2, 3)]
    const env = fine(4, -50, [{ from: 0, to: 1, db: -20 }, { from: 2, to: 3, db: -20 }])
    expect(speechFloorDb(env, words)).toBeCloseTo(-20 - EDIT_RULES.pacing.loudGameMarginDb, 6)
    expect(speechFloorDb({ startSec: 0, stepSec: 1, db: [-20, -50, -20, -50] }, words)).toBeNull()
    expect(speechFloorDb(env, [])).toBeNull()
    expect(speechFloorDb(null, words)).toBeNull()
  })

  it('calls a gap loud when game sound inside it is near the speech level', () => {
    const quiet = fine(4, -50, [{ from: 0, to: 1, db: -20 }, { from: 3, to: 4, db: -20 }])
    const game = fine(4, -50, [{ from: 0, to: 4, db: -22 }])
    const floor = -26
    expect(isLoudGap(quiet, floor, 1, 3)).toBe(false)
    expect(isLoudGap(game, floor, 1, 3)).toBe(true)
    // A coarse envelope cannot separate a gap from the words beside it.
    expect(isLoudGap({ startSec: 0, stepSec: 1, db: [-20, -20, -20, -20] }, floor, 1, 3)).toBe(false)
    expect(isLoudGap(game, null, 1, 3)).toBe(false)
  })
})

describe('length checks', () => {
  it('fits each platform cap on its own', () => {
    const fit = capFit(75)
    expect(fit.tiktok).toEqual({ capSec: 60, fits: false })
    expect(fit.shorts.fits).toBe(false)
    expect(fit.reels).toEqual({ capSec: 90, fits: true })
    expect(capFit(60).tiktok.fits).toBe(true)
  })

  it('passes at the floor, fails under it, and reports the target and caps', () => {
    expect(checkLength(10, { editSkipped: false, extendedSec: 0 }).status).toBe('pass')
    expect(checkLength(9.9, { editSkipped: true, extendedSec: 1.5 }).status).toBe('fail')
    const r = checkLength(20, { editSkipped: false, extendedSec: 0 })
    expect(r.values.inTarget).toBe(true)
    expect(r.values.fitsReels).toBe(true)
    expect(checkLength(50, { editSkipped: false, extendedSec: 0 }).values.inTarget).toBe(false)
  })
})

describe('content floor', () => {
  it('counts a chat second as a peak from three chatters of reaction weight, local maxima 5 s apart', () => {
    const s = new Float64Array(30)
    s[5] = 4
    s[6] = 3
    s[8] = 3.5 // within 5 s of the peak at 5: the same peak
    s[20] = 3
    s[25] = 2 // under the minimum
    expect(countChatPeaks(s)).toBe(2)
    expect(countChatPeaks(null)).toBe(0)
  })

  it('measures words plus loud frames over the final edit, counting overlap once', () => {
    const segs = [{ srcStart: 0, srcEnd: 10, speed: 1 }]
    expect(contentCoverage(segs, [word(0, 2), word(4, 6)], null, { from: 0, to: 10 })).toBeCloseTo(0.4, 6)
    // A loud second overlapping a word adds only the part outside it.
    const env = fine(10, -60, [{ from: 1, to: 3, db: -20 }])
    expect(contentCoverage(segs, [word(0, 2)], env, { from: 0, to: 10 })).toBeCloseTo(0.3, 6)
  })

  it('only counts what lies inside the kept segments', () => {
    const segs = [{ srcStart: 0, srcEnd: 2, speed: 1 }, { srcStart: 8, srcEnd: 10, speed: 1 }]
    expect(contentCoverage(segs, [word(1, 9)], null, { from: 0, to: 10 })).toBeCloseTo(0.5, 6)
  })

  it('needs a chat peak (when there is chat) and 40% coverage', () => {
    expect(checkContent(1, 0.5).status).toBe('pass')
    expect(checkContent(0, 0.9).status).toBe('fail')
    expect(checkContent(2, 0.39).status).toBe('fail')
    expect(checkContent(null, 0.5).status).toBe('pass') // no chat replay to judge
  })

  it('lets a strong loudness peak stand in for the chat peak, but still needs the coverage', () => {
    expect(checkContent(0, 0.9, true)).toMatchObject({ status: 'pass', values: { loudPeak: true } })
    expect(checkContent(0, 0.2, true).status).toBe('fail')
  })

  it('lets a transcript moment stand in for the chat peak, but still needs the coverage', () => {
    expect(checkContent(0, 0.9, false, true)).toMatchObject({ status: 'pass', values: { transcriptMoment: true } })
    expect(checkContent(0, 0.2, false, true).status).toBe('fail')
  })
})

describe('hook checks', () => {
  it('finds the first word, or with none the first frame well over the median', () => {
    expect(firstEventSec([word(1.2, 1.5)], null, { from: 0, to: 10 })).toBe(1.2)
    const env = fine(10, -45, [{ from: 4, to: 6, db: -20 }])
    expect(firstEventSec([], env, { from: 0, to: 10 })).toBeCloseTo(4, 1)
    expect(firstEventSec([], null, { from: 0, to: 10 })).toBeNull()
    expect(firstEventSec([], fine(10, -45), { from: 0, to: 10 })).toBeNull()
  })

  it('trims a lead-in over 0.3 s to 0.15 s and leaves a shorter one', () => {
    expect(hookStartSec(2)).toBeCloseTo(1.85, 6)
    expect(hookStartSec(0.3)).toBe(0)
    expect(hookStartSec(0.31)).toBeCloseTo(0.16, 6)
    expect(hookStartSec(null)).toBe(0)
    expect(hookStartSec(0.2)).toBe(0)
  })

  it('grades the first event at 0.5 s soft and 1.0 s hard', () => {
    expect(checkHook(0.15, true)).toMatchObject({ status: 'pass', values: { grade: 'soft' } })
    expect(checkHook(0.8, true)).toMatchObject({ status: 'pass', values: { grade: 'hard' } })
    expect(checkHook(1.4, true)).toMatchObject({ status: 'fail', values: { grade: 'late' } })
    expect(checkHook(0.1, false).status).toBe('fail')
    expect(checkHook(null, true).status).toBe('na')
  })

  it('needs frame 0 to be a moving segment with no card in front', () => {
    expect(frameZeroIsContent(edl())).toBe(true)
    expect(frameZeroIsContent(edl({ segments: [] }))).toBe(false)
    expect(frameZeroIsContent(edl({ overlays: [{ kind: 'quoteBar', t0: 0, t1: 0.6, text: 'hi', pos: { x: 0.5, y: 0.15, align: 'center' } }] }))).toBe(true)
    expect(frameZeroIsContent(edl({ overlays: [{ kind: 'chatBubble', t0: 0, t1: 1, text: 'hi', pos: { x: 0.5, y: 0.2, align: 'center' } }] }))).toBe(false)
  })
})

describe('pacing check', () => {
  it('passes when every cut left at least 0.15 s each side, and counts pauses still over the trigger', () => {
    const ok = checkPacing(edl(), [word(0, 1), word(1.2, 2)], { cuts: 2, savedSec: 1.4, minKeptGap: 0.3, loudGapsKept: 1 })
    expect(ok).toMatchObject({ check: 'pacing', status: 'pass', values: { cuts: 2, pausesLeft: 0, loudGapsKept: 1 } })
    expect(checkPacing(edl(), [word(0, 1), word(3, 4)], { cuts: 0, savedSec: 0, minKeptGap: null, loudGapsKept: 0 }).values.pausesLeft).toBe(1)
    expect(checkPacing(edl(), [], { cuts: 1, savedSec: 1, minKeptGap: 0.2, loudGapsKept: 0 }).status).toBe('fail')
  })
})

describe('formatCheckLine', () => {
  it('writes one compact line: check, clip, status and the values', () => {
    const line = formatCheckLine('ab12cd34', { check: 'length', status: 'pass', values: { final: 23.456, floor: 10, inTarget: true, extended: null } })
    expect(line).toBe('rule length clip=ab12cd34 pass final=23.46 floor=10 inTarget=true extended=null')
    expect(line).not.toContain('\n')
  })
})
