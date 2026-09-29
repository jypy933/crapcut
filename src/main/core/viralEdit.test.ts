import { describe, expect, it } from 'vitest'
import type { ChatMessage, Word } from '@shared/types'
import { outputDuration, validateEdl } from './edl'
import { pickStructure } from './structurePick'
import { computeSignals, type ClipFacts } from './structureSignals'
import { buildViralEdl, type ViralEditOptions } from './viralEdit'

/** A word every `gap` seconds, `n` of them, starting at `start` (VOD seconds). */
function speech(start: number, n: number, gap = 0.4, wordLen = 0.3, textAt: Record<number, string> = {}): Word[] {
  const out: Word[] = []
  for (let i = 0; i < n; i++) {
    const t0 = start + i * gap
    out.push({ t0, t1: t0 + wordLen, text: textAt[i] ?? 'blah' })
  }
  return out
}

/** Flat quiet loudness with a loud burst of `db` dB for `len` seconds at `at` (VOD seconds), offset 0. */
function loudness(totalSec: number, at: number, len: number, db: number): Float64Array {
  const out = new Float64Array(totalSec).fill(-50)
  for (let t = Math.max(0, Math.floor(at)); t < Math.min(totalSec, Math.ceil(at + len)); t++) out[t] = db
  return out
}

/** Loudness that stays active (never counts as silent) at `baseDb`, with a louder burst at `at`. */
function activeLoudness(totalSec: number, baseDb: number, at: number, len: number, burstDb: number): Float64Array {
  const out = new Float64Array(totalSec).fill(baseDb)
  for (let t = Math.max(0, Math.floor(at)); t < Math.min(totalSec, Math.ceil(at + len)); t++) out[t] = burstDb
  return out
}

function chatBurst(at: number, len: number, perSec: number, users = 'abcdefgh'): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let t = at; t < at + len; t++) for (let k = 0; k < perSec; k++) out.push({ t: t + k / perSec, user: `${users[k % users.length]}${t}`, text: 'KEKW' })
  return out
}

function facts(partial: Partial<ClipFacts>): ClipFacts {
  return { window: { start: 0, end: 30 }, words: [], chatMessages: [], loudness: null, loudnessOffset: 0, ...partial }
}

const FAKE_SFX: ViralEditOptions = { sfx: { boom: 'boom.wav', whoosh: 'whoosh.wav', pop: 'pop.wav' } }

/** Sanity every recipe must satisfy: a playable EDL that never outgrows the clip by more than a short freeze/loop tail. */
function expectSaneEdl(f: ClipFacts, options: ViralEditOptions = {}): ReturnType<typeof buildViralEdl> {
  const signals = computeSignals(f)
  const decision = pickStructure(signals, f.words, f.window.start)
  const edl = buildViralEdl(decision, f, options)
  const clipLength = f.window.end - f.window.start
  expect(validateEdl(edl, clipLength)).toEqual([])
  expect(outputDuration(edl)).toBeGreaterThan(0)
  expect(outputDuration(edl)).toBeLessThan(clipLength + 2.5)
  return edl
}

describe('buildViralEdl: payoffFirst', () => {
  it('opens with a cold-open replay of the peak before the full build-up', () => {
    const f = facts({ window: { start: 100, end: 130 }, words: speech(100, 20, 0.4), loudness: loudness(200, 102, 3, -5) })
    const signals = computeSignals(f)
    const decision = pickStructure(signals, f.words, f.window.start)
    expect(decision.structure).toBe('payoffFirst')
    const edl = expectSaneEdl(f, FAKE_SFX)
    expect(edl.segments.length).toBe(2)
    expect(edl.segments[0]!.srcEnd).toBeGreaterThan(edl.segments[0]!.srcStart)
    // The cold-open reorder cut gets a whoosh, the peak zoom gets a boom.
    expect(edl.sfx.some((s) => s.file === 'whoosh.wav')).toBe(true)
    expect(edl.sfx.some((s) => s.file === 'boom.wav')).toBe(true)
    expect(edl.zoom.length).toBeGreaterThan(0)
  })

  it('falls back to a plain cut when there is no usable cold-open span (degraded)', () => {
    const f = facts({ window: { start: 0, end: 0.05 } }) // too short for computeSignals to find a hook span
    const decision = pickStructure(computeSignals(f), f.words, f.window.start)
    const edl = buildViralEdl({ ...decision, structure: 'payoffFirst', coldOpenSpan: undefined }, f, FAKE_SFX)
    expect(validateEdl(edl, f.window.end - f.window.start)).toEqual([])
    expect(edl.segments.length).toBe(1)
  })
})

describe('buildViralEdl: quoteCard', () => {
  it('opens on a freeze with the verbatim quote and loops back when the peak is late', () => {
    // The loud burst at VOD second 116 (clip-relative 26) puts the peak late in the clip;
    // the quotable phrase ends right next to it so it counts as "at the peak".
    const words = [...speech(90, 5, 0.4), ...speech(114, 4, 0.35, 0.3, { 0: 'no', 1: 'way', 2: 'he', 3: 'hit.' })]
    const f = facts({ window: { start: 90, end: 120 }, words, loudness: activeLoudness(200, -50, 116, 2, -5) })
    const signals = computeSignals(f)
    const decision = pickStructure(signals, f.words, f.window.start)
    expect(decision.structure).toBe('quoteCard')
    const edl = expectSaneEdl(f, FAKE_SFX)
    expect(edl.freeze.length).toBe(1)
    expect(edl.freeze[0]!.atOutputT).toBe(0)
    expect(edl.overlays.length).toBe(1)
    expect(edl.overlays[0]!.kind).toBe('quoteBar')
    expect(edl.overlays[0]!.text).toBe('no way he hit.')
    expect(edl.sfx.some((s) => s.file === 'pop.wav')).toBe(true)
    if (decision.loopEnding) expect(edl.ending.kind).toBe('loop')
  })

  it('produces a plain edit with no overlay when there is no quotable span (degraded)', () => {
    const f = facts({ window: { start: 0, end: 20 }, words: speech(0, 20, 0.4) })
    const decision = pickStructure(computeSignals(f), f.words, f.window.start)
    const edl = buildViralEdl({ ...decision, structure: 'quoteCard', quoteSpan: undefined, loopEnding: false }, f, FAKE_SFX)
    expect(validateEdl(edl, f.window.end - f.window.start)).toEqual([])
    expect(edl.overlays).toEqual([])
    expect(edl.freeze).toEqual([])
  })
})

describe('buildViralEdl: buildAndPunch', () => {
  it('pushes in slowly through the setup, then snaps the rest of the way at the peak', () => {
    const f = facts({ window: { start: 0, end: 30 }, words: speech(0, 40, 0.4), loudness: loudness(30, 9, 2, -5) })
    const signals = computeSignals(f)
    const decision = pickStructure(signals, f.words, f.window.start)
    expect(decision.structure).toBe('buildAndPunch')
    const edl = expectSaneEdl(f, FAKE_SFX)
    const scales = edl.zoom.map((z) => z.scale)
    expect(Math.max(...scales)).toBeCloseTo(1.13, 1)
    // A push scale strictly between neutral and the full punch shows up before the snap.
    expect(scales.some((s) => s > 1 && s < 1.1)).toBe(true)
    expect(scales[scales.length - 1]).toBeCloseTo(1, 5)
  })
})

describe('buildViralEdl: rapidFire', () => {
  it('places small zooms on sub-peaks, capped and spaced apart', () => {
    const l = new Float64Array(40).fill(-50)
    for (const at of [4, 14, 24, 34]) for (let t = at; t < at + 2; t++) l[t] = -5
    const f = facts({ window: { start: 0, end: 40 }, loudness: l })
    const signals = computeSignals(f)
    const decision = pickStructure(signals, f.words, f.window.start)
    expect(decision.structure).toBe('rapidFire')
    const edl = expectSaneEdl(f, FAKE_SFX)
    const punchScales = edl.zoom.filter((z) => z.scale > 1.02).map((z) => z.scale)
    expect(punchScales.length).toBeGreaterThan(0)
    for (const s of punchScales) expect(s).toBeLessThan(1.1) // small, not the full punch
    // Only the strongest sub-peak gets a boom -- sparing use, not one per burst.
    expect(edl.sfx.filter((s) => s.file === 'boom.wav').length).toBeLessThanOrEqual(1)
  })

  it('falls back to the overall peak with no sub-peak signal (degraded)', () => {
    const f = facts({ window: { start: 0, end: 10 } })
    const decision = pickStructure(computeSignals(f), f.words, f.window.start)
    const edl = buildViralEdl({ ...decision, structure: 'rapidFire' }, f, FAKE_SFX)
    expect(validateEdl(edl, 10)).toEqual([])
    expect(edl.zoom.length).toBeGreaterThan(0)
  })
})

describe('buildViralEdl: freezeLoop', () => {
  it('always ends on a loop', () => {
    // No words at all, so there is no quotable span to compete with (quoteCard would
    // otherwise outscore freezeLoop at a peak this late); an active (non-silent)
    // clip with a late, louder peak is exactly freezeLoop's shape.
    const f = facts({ window: { start: 0, end: 30 }, loudness: activeLoudness(30, -25, 27, 2, -5) })
    const signals = computeSignals(f)
    const decision = pickStructure(signals, f.words, f.window.start)
    expect(decision.structure).toBe('freezeLoop')
    const edl = expectSaneEdl(f, FAKE_SFX)
    expect(edl.ending.kind).toBe('loop')
  })
})

describe('buildViralEdl: chatFirst', () => {
  it('shows the real chat messages the decision names, as verbatim bubbles', () => {
    const chatMessages = chatBurst(5, 3, 10)
    const words = speech(0, 3, 5)
    const f = facts({ window: { start: 0, end: 20 }, words, chatMessages, loudness: loudness(20, 15, 2, -5) })
    const signals = computeSignals(f)
    const decision = { ...pickStructure(signals, f.words, f.window.start), structure: 'chatFirst' as const, chatMessageIds: [0, 1, 2] }
    const edl = buildViralEdl(decision, f, FAKE_SFX)
    expect(validateEdl(edl, 20)).toEqual([])
    expect(edl.overlays.length).toBeGreaterThan(0)
    for (const o of edl.overlays) {
      expect(o.kind).toBe('chatBubble')
      expect(o.text).toBe('KEKW') // verbatim, never generated
    }
  })

  it('produces no bubbles with no chat messages named (degraded)', () => {
    const f = facts({ window: { start: 0, end: 20 }, words: speech(0, 10, 0.5) })
    const decision = pickStructure(computeSignals(f), f.words, f.window.start)
    const edl = buildViralEdl({ ...decision, structure: 'chatFirst', chatMessageIds: undefined }, f, FAKE_SFX)
    expect(validateEdl(edl, 20)).toEqual([])
    expect(edl.overlays).toEqual([])
  })
})

describe('buildViralEdl: tightCut', () => {
  it('is a plain cut with one peak zoom when nothing else stands out', () => {
    // A single shouted word breaks the tie among otherwise-flat word-emphasis
    // fallback scores and puts the peak in the middle of the clip -- not early
    // enough for payoffFirst, not in buildAndPunch's ramp range, and (because
    // every word here is its own pause-bounded "sentence") too short to read
    // as a quotable span.
    const f = facts({ window: { start: 0, end: 30 }, words: speech(0, 30, 1, 0.3, { 15: 'NO!' }) })
    const signals = computeSignals(f)
    const decision = pickStructure(signals, f.words, f.window.start)
    expect(decision.structure).toBe('tightCut')
    const edl = expectSaneEdl(f, FAKE_SFX)
    expect(edl.ending.kind).toBe('cut')
    expect(edl.freeze).toEqual([])
    expect(edl.overlays).toEqual([])
    expect(edl.zoom.length).toBeGreaterThan(0)
  })
})

describe('buildViralEdl: degraded input', () => {
  it('handles no words, no chat and no loudness without throwing, for every structure', () => {
    const f = facts({ window: { start: 0, end: 12 } })
    for (const structure of ['tightCut', 'payoffFirst', 'quoteCard', 'buildAndPunch', 'rapidFire', 'freezeLoop', 'chatFirst'] as const) {
      const decision = pickStructure(computeSignals(f), f.words, f.window.start)
      const edl = buildViralEdl({ ...decision, structure }, f, FAKE_SFX)
      expect(validateEdl(edl, 12)).toEqual([])
      expect(outputDuration(edl)).toBeGreaterThan(0)
    }
  })

  it('never emits an sfx cue for a kind with no rendered file', () => {
    const f = facts({ window: { start: 0, end: 20 }, words: speech(0, 20, 0.5), loudness: loudness(20, 15, 2, -5) })
    const decision = pickStructure(computeSignals(f), f.words, f.window.start)
    const edl = buildViralEdl(decision, f, {})
    expect(edl.sfx).toEqual([])
  })

  it('handles a very short clip without throwing', () => {
    const f = facts({ window: { start: 0, end: 0.4 }, words: speech(0, 1, 0.1) })
    const decision = pickStructure(computeSignals(f), f.words, f.window.start)
    const edl = buildViralEdl(decision, f, FAKE_SFX)
    expect(validateEdl(edl, 0.4)).toEqual([])
  })
})
