import { describe, expect, it } from 'vitest'
import { SAFE_ZONES } from '@shared/captionSafeZone'
import type { ClipEditPlan } from '@shared/editPlan'
import type { Word } from '@shared/types'
import { capFit } from './editRules'
import { outputDuration, validateEdl, type Edl, type OverlayCue } from './edl'
import { capCutPoint, fitOverlaysToZone, outputSignature, outputToConcatTime, pickVersion, planPlatform, platformNote, truncateEdl } from './platformPlan'

const cut = (over: Partial<Edl> = {}): Edl => ({ segments: [], zoom: [], freeze: [], overlays: [], sfx: [], ending: { kind: 'cut' }, ...over })
const whole = (sec: number, over: Partial<Edl> = {}): Edl => cut({ segments: [{ srcStart: 0, srcEnd: sec, speed: 1 }], zoom: [{ t: 0, scale: 1, ease: 'snap' }], ...over })

/** Sentences of four 0.3 s words, a 0.7 s pause after each, the last word ending in a full stop, up to `sec`. */
function sentences(sec: number): Word[] {
  const out: Word[] = []
  for (let t = 0; t + 1.5 < sec; t += 2.2) {
    for (let i = 0; i < 4; i++) out.push({ t0: t + i * 0.4, t1: t + i * 0.4 + 0.3, text: i === 3 ? `w${out.length}.` : `w${out.length}` })
  }
  return out
}

/** Words with no pause anywhere and no full stop: nowhere to end cleanly. */
function rambling(sec: number): Word[] {
  const out: Word[] = []
  for (let t = 0; t + 0.4 < sec; t += 0.4) out.push({ t0: t, t1: t + 0.35, text: `w${out.length}` })
  return out
}

const planWith = (loopEligible: boolean): ClipEditPlan => ({
  finalSec: 30,
  editSkipped: false,
  extendedSec: 0,
  belowFloor: false,
  capFit: capFit(30),
  coldOpen: { qualifies: false, confidence: 0, llm: 'unavailable', payoffVodSec: null, previewSec: 0, finalSec: 0, segments: [], capFit: capFit(0), reasons: [] },
  loop: { eligible: loopEligible, endSec: 29, seamScore: 0.9, loudnessDiffLu: 1, quietSec: 0.25, calibrated: false }
})

describe('pickVersion', () => {
  const straight = whole(30)
  const cold = whole(33, { segments: [{ srcStart: 20, srcEnd: 23, speed: 1 }, { srcStart: 0, srcEnd: 30, speed: 1 }] })

  it('gives the cold open when it is wanted and exists, else the straight edit', () => {
    expect(pickVersion({ edl: straight, coldOpenEdl: cold, plan: planWith(false) }, 'coldOpen')).toEqual({ version: 'coldOpen', edl: cold })
    expect(pickVersion({ edl: straight, coldOpenEdl: cold, plan: planWith(false) }, 'straight').version).toBe('straight')
    expect(pickVersion({ edl: straight, coldOpenEdl: cold, plan: planWith(false) }, undefined).version).toBe('straight')
    // The cold open went away (a trim): back to the straight edit rather than failing.
    expect(pickVersion({ edl: straight, coldOpenEdl: null, plan: planWith(false) }, 'coldOpen')).toEqual({ version: 'straight', edl: straight })
  })

  it('keeps a loop only when that version passed its seam', () => {
    const looped = whole(29, { ending: { kind: 'loop', crossfadeSec: 0.06 } })
    expect(pickVersion({ edl: looped, coldOpenEdl: null, plan: planWith(true) }, 'straight').edl.ending.kind).toBe('loop')
    expect(pickVersion({ edl: looped, coldOpenEdl: null, plan: planWith(false) }, 'straight').edl.ending.kind).toBe('cut')
  })
})

describe('outputToConcatTime', () => {
  it('is the identity without freezes', () => {
    expect(outputToConcatTime([], 12.5)).toBe(12.5)
  })

  it('takes out the hold of every freeze before the point, and lands on the freeze inside one', () => {
    const freeze = [{ atOutputT: 4, holdSec: 1.5 }]
    expect(outputToConcatTime(freeze, 3)).toBe(3)
    expect(outputToConcatTime(freeze, 4.8)).toBe(4)
    expect(outputToConcatTime(freeze, 8)).toBeCloseTo(6.5)
  })
})

describe('truncateEdl', () => {
  const overlay = (t0: number, t1: number): OverlayCue => ({ kind: 'chatBubble', t0, t1, text: 'KEKW', pos: { x: 0.5, y: 0.22, align: 'center' } })
  const full = cut({
    segments: [
      { srcStart: 0, srcEnd: 10, speed: 1 },
      { srcStart: 12, srcEnd: 30, speed: 1 }
    ],
    zoom: [
      { t: 0, scale: 1, ease: 'snap' },
      { t: 8, scale: 1.2, ease: 'smooth' },
      { t: 24, scale: 1.3, ease: 'snap' }
    ],
    overlays: [overlay(2, 4), overlay(18, 20), overlay(22, 26)],
    sfx: [
      { t: 3, file: 'a.wav', gainDb: -6 },
      { t: 25, file: 'b.wav', gainDb: -6 }
    ],
    ending: { kind: 'loop', crossfadeSec: 0.06 }
  })

  it('cuts inside a segment and drops what no longer fits', () => {
    const t = truncateEdl(full, 20)
    expect(outputDuration(t)).toBeCloseTo(20)
    expect(t.segments).toEqual([
      { srcStart: 0, srcEnd: 10, speed: 1 },
      { srcStart: 12, srcEnd: 22, speed: 1 }
    ])
    expect(t.zoom.map((z) => z.t)).toEqual([0, 8])
    expect(t.overlays.map((o) => [o.t0, o.t1])).toEqual([
      [2, 4],
      [18, 20]
    ])
    expect(t.sfx.map((s) => s.t)).toEqual([3])
    expect(validateEdl(t, 30)).toEqual([])
  })

  it('always ends in a plain cut, even when the original was a loop', () => {
    expect(truncateEdl(full, 26).ending).toEqual({ kind: 'cut' })
  })

  it('clamps an overlay that runs past the cut and drops whole segments after it', () => {
    const t = truncateEdl(full, 9)
    expect(t.segments).toEqual([{ srcStart: 0, srcEnd: 9, speed: 1 }])
    expect(t.overlays.map((o) => o.t1)).toEqual([4])
  })

  it('honours segment speed and freezes', () => {
    const fast = cut({ segments: [{ srcStart: 0, srcEnd: 20, speed: 2 }], freeze: [{ atOutputT: 2, holdSec: 1 }] })
    expect(outputDuration(fast)).toBeCloseTo(11)
    const t = truncateEdl(fast, 6)
    // 6 s of output = 1 s of hold + 5 s of the sped-up segment = 10 s of source.
    expect(outputDuration(t)).toBeCloseTo(6)
    expect(t.segments[0]!.srcEnd).toBeCloseTo(10)
  })
})

describe('capCutPoint', () => {
  it('ends on the last phrase end at or under the cap, a little after the word', () => {
    const words = sentences(70)
    const at = capCutPoint(words, 60)!
    expect(at).toBeLessThanOrEqual(60)
    expect(at).toBeGreaterThan(56)
    // It sits just after a sentence's last word, never inside a sentence.
    const last = words.filter((w) => w.text.endsWith('.') && w.t1 + 0.1 <= at).pop()!
    expect(at).toBeCloseTo(last.t1 + 0.1 + 0.2)
  })

  it('finds nothing in speech without a pause or a full stop', () => {
    expect(capCutPoint(rambling(70), 60)).toBeNull()
  })

  it('does not cut into the next word', () => {
    const words: Word[] = [
      { t0: 0, t1: 5.5, text: 'one.' },
      { t0: 5.68, t1: 6, text: 'two' }
    ]
    expect(capCutPoint(words, 6)).toBeCloseTo(5.68)
  })
})

describe('planPlatform', () => {
  const input = (sec: number, words = sentences(sec), payoffSec: number | null = 20, edl = whole(sec)) => ({ edl, words, payoffSec })

  it('exports a clip inside the cap untouched, for every platform', () => {
    for (const p of ['tiktok', 'shorts', 'reels'] as const) {
      const plan = planPlatform(input(40), p)
      expect(plan).toMatchObject({ action: 'export', trimmedSec: 0, finalSec: 40 })
      expect(platformNote(plan)).toBeNull()
    }
  })

  it('holds the same 62 s clip to 60 s on TikTok and Shorts, and lets Reels have all of it (90 s cap)', () => {
    const tiktok = planPlatform(input(62), 'tiktok')
    const shorts = planPlatform(input(62), 'shorts')
    const reels = planPlatform(input(62), 'reels')
    if (tiktok.action !== 'export' || shorts.action !== 'export' || reels.action !== 'export') throw new Error('expected exports')
    expect(tiktok.finalSec).toBeLessThanOrEqual(60)
    expect(tiktok.finalSec).toBeGreaterThan(56)
    expect(tiktok.trimmedSec).toBeGreaterThan(0)
    expect(shorts.finalSec).toBeCloseTo(tiktok.finalSec)
    expect(reels).toMatchObject({ trimmedSec: 0, finalSec: 62 })
    expect(validateEdl(tiktok.edl, 62)).toEqual([])
    expect(platformNote(tiktok)).toBe('Ends a few seconds early on TikTok to stay within 60 s.')
    expect(platformNote(reels)).toBeNull()
  })

  it('skips a platform instead of chopping a long clip down: over the cap by more than the trim allows', () => {
    const plan = planPlatform(input(75), 'shorts')
    expect(plan).toMatchObject({ action: 'skip', platform: 'shorts', capSec: 60 })
    expect(platformNote(plan)).toBe('Not made for Shorts: the clip is over 60 s.')
    // Reels' 90 s cap holds it.
    expect(planPlatform(input(75), 'reels')).toMatchObject({ action: 'export', trimmedSec: 0 })
    // And a 100 s clip is over every cap.
    expect(planPlatform(input(100), 'reels').action).toBe('skip')
  })

  it('skips when the speech has no clean place to end', () => {
    expect(planPlatform(input(62, rambling(62)), 'tiktok')).toMatchObject({ action: 'skip', reason: 'no place to end it cleanly' })
  })

  it('never trims off the payoff and its reaction beat', () => {
    // The payoff sits at 59.9 s: any clean cut under 60 s would land before its beat is over.
    const plan = planPlatform(input(62, sentences(62), 59.9), 'tiktok')
    expect(plan).toMatchObject({ action: 'skip', reason: 'the end would lose the payoff' })
  })

  it('drops a loop ending when it has to trim, and keeps it when it fits', () => {
    const looped = (sec: number): Edl => whole(sec, { ending: { kind: 'loop', crossfadeSec: 0.06 } })
    expect(planPlatform(input(28, sentences(28), 14, looped(28)), 'tiktok')).toMatchObject({ action: 'export', loop: true })
    const trimmed = planPlatform(input(62, sentences(62), 20, looped(62)), 'tiktok')
    expect(trimmed).toMatchObject({ action: 'export', loop: false })
    if (trimmed.action === 'export') expect(trimmed.edl.ending.kind).toBe('cut')
  })

  it('finds the payoff of a cold open at its real place, not at the preview', () => {
    // A 3 s preview of the payoff (source 40-43) in front of the 60 s straight edit: 63 s in all.
    const edl = cut({ segments: [{ srcStart: 40, srcEnd: 43, speed: 1 }, { srcStart: 0, srcEnd: 60, speed: 1 }], zoom: [{ t: 0, scale: 1, ease: 'snap' }] })
    const plan = planPlatform({ edl, words: sentences(60), payoffSec: 41 }, 'tiktok')
    expect(plan.action).toBe('export')
    if (plan.action === 'export') {
      expect(plan.trimmedSec).toBeGreaterThan(0)
      expect(plan.finalSec).toBeLessThanOrEqual(60)
      // The preview is still first and the payoff's real place (source 41, at 44 s out) is kept.
      expect(plan.edl.segments[0]).toEqual({ srcStart: 40, srcEnd: 43, speed: 1 })
      expect(outputDuration(plan.edl)).toBeGreaterThan(44 + 0.5)
    }
  })
})

describe('fitOverlaysToZone', () => {
  const overlay = (x: number, y: number): OverlayCue => ({ kind: 'quoteBar', t0: 0, t1: 2, text: 'hi', pos: { x, y, align: 'center' } })
  const frame = { width: 1080, height: 1920 }

  it('leaves overlays inside the zone as they are', () => {
    const o = overlay(0.5, 0.3)
    expect(fitOverlaysToZone([o], SAFE_ZONES.reels, frame)[0]).toBe(o)
  })

  it('moves a hook that sits too high into the Reels zone (inside the grid and feed crops), and one too low up', () => {
    const [high, low] = fitOverlaysToZone([overlay(0.5, 0.05), overlay(0.5, 0.95)], SAFE_ZONES.reels, frame)
    expect(high!.pos.y * 1920).toBeGreaterThanOrEqual(SAFE_ZONES.reels.top + 60 - 1e-6)
    expect(low!.pos.y * 1920).toBeLessThanOrEqual(SAFE_ZONES.reels.bottom - 60 + 1e-6)
  })

  it('uses each platform its own zone', () => {
    const y = 0.13
    expect(fitOverlaysToZone([overlay(0.5, y)], SAFE_ZONES.tiktok, frame)[0]!.pos.y).toBeCloseTo(y)
    expect(fitOverlaysToZone([overlay(0.5, y)], SAFE_ZONES.reels, frame)[0]!.pos.y).toBeGreaterThan(y)
  })
})

describe('outputSignature', () => {
  it('is equal when the edit and the burned-in text are, so a platform can copy the file', () => {
    expect(outputSignature(whole(30), 'ass', null)).toBe(outputSignature(whole(30), 'ass', null))
  })

  it('differs when a platform fitted the captions or overlays differently, or trimmed the edit', () => {
    const base = outputSignature(whole(30), 'ass-y-0.70', null)
    expect(outputSignature(whole(30), 'ass-y-0.64', null)).not.toBe(base)
    expect(outputSignature(whole(30), 'ass-y-0.70', 'overlay')).not.toBe(base)
    expect(outputSignature(whole(29.4), 'ass-y-0.70', null)).not.toBe(base)
  })
})
