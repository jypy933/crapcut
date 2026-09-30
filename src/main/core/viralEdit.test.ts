import { describe, expect, it } from 'vitest'
import type { ChatMessage, Word } from '@shared/types'
import { outputDuration, validateEdl } from './edl'
import { pickStructure } from './structurePick'
import { computeSignals, type ClipFacts } from './structureSignals'
import type { ColdOpenPlan } from '@shared/editPlan'
import { capFit, type Envelope } from './editRules'
import { buildViralEdit, buildViralEdl, coldOpenVariantEdl, type ViralEditOptions } from './viralEdit'

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
  it('is a tight cut: the clip already opens on its payoff, so nothing is replayed', () => {
    const f = facts({ window: { start: 100, end: 130 }, words: speech(100, 20, 0.4), loudness: loudness(200, 102, 3, -5) })
    const signals = computeSignals(f)
    const decision = pickStructure(signals, f.words, f.window.start)
    expect(decision.structure).toBe('payoffFirst')
    const edl = expectSaneEdl(f, FAKE_SFX)
    // One continuous segment: the old cold-open replay showed the payoff's words twice within 3 s.
    expect(edl.segments.length).toBe(1)
    expect(edl.sfx.some((s) => s.file === 'whoosh.wav')).toBe(false)
    expect(edl.sfx.some((s) => s.file === 'boom.wav')).toBe(true)
    expect(edl.zoom.length).toBeGreaterThan(0)
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
    // A loop is a property of the version the rule engine approved, not of the structure alone.
    expect(edl.ending.kind).toBe('cut')
    expect(buildViralEdl(decision, f, { ...FAKE_SFX, loop: { endSec: 29, crossfadeSec: 0.06 } }).ending).toEqual({ kind: 'loop', crossfadeSec: 0.06 })
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
    expect(decision.loopEnding).toBe(true)
    expect(expectSaneEdl(f, FAKE_SFX).ending.kind).toBe('cut')
    const looped = expectSaneEdl(f, { ...FAKE_SFX, loop: { endSec: 28, crossfadeSec: 0.06 } })
    expect(looped.ending).toEqual({ kind: 'loop', crossfadeSec: 0.06 })
    expect(outputDuration(looped)).toBeLessThanOrEqual(28)
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

/** A fine (0.1 s) envelope over `total` seconds: `base` dB everywhere with `spans` of another level, clip start = VOD 0. */
function fineEnvelope(total: number, base: number, spans: { from: number; to: number; db: number }[] = []): Envelope {
  const db = new Array<number>(Math.round(total * 10)).fill(base)
  for (const s of spans) for (let i = Math.round(s.from * 10); i < Math.round(s.to * 10); i++) db[i] = s.db
  return { startSec: 0, stepSec: 0.1, db }
}

function tightFacts(words: Word[], end = 20): ClipFacts {
  return facts({ window: { start: 0, end }, words })
}

describe('buildViralEdit: pacing', () => {
  const decisionFor = (f: ClipFacts) => ({ ...pickStructure(computeSignals(f), f.words, f.window.start), structure: 'tightCut' as const })

  it('cuts a 1.7 s pause down to about 0.30 s, at least 0.15 s of air each side', () => {
    const words = [...speech(0, 6, 0.4), ...speech(4, 6, 0.4)] // a hole between the word ending at 2.3 and the one at 4
    const f = tightFacts(words)
    const { edl, stats } = buildViralEdit(decisionFor(f), f)
    expect(stats.cuts).toBe(1)
    const [a, b] = edl.segments
    const kept = 1.7 - (b!.srcStart - a!.srcEnd)
    expect(kept).toBeCloseTo(0.3, 2)
    expect(kept / 2).toBeGreaterThanOrEqual(0.15 - 1e-9)
    expect(stats.minKeptGap).toBeCloseTo(0.3, 2)
  })

  it('leaves a 0.45 s pause alone (under the 0.5 s trigger)', () => {
    const f = tightFacts([...speech(0, 4, 0.4), ...speech(1.95, 4, 0.4)])
    expect(buildViralEdit(decisionFor(f), f).stats.cuts).toBe(0)
  })

  it('needs a 0.7 s pause before cutting one with loud game sound in it', () => {
    // The 0.6 s pause sits between the word ending at 1.3 and the one starting at 1.9.
    const words: Word[] = [
      { t0: 0, t1: 0.3, text: 'so' },
      { t0: 0.35, t1: 0.65, text: 'watch' },
      { t0: 0.7, t1: 1.3, text: 'this' },
      { t0: 1.9, t1: 2.2, text: 'now' },
      { t0: 2.25, t1: 2.55, text: 'okay' }
    ]
    const f = tightFacts(words)
    const quiet = fineEnvelope(20, -50, [{ from: 0, to: 1.3, db: -20 }, { from: 1.9, to: 2.55, db: -20 }])
    const loud = fineEnvelope(20, -50, [{ from: 0, to: 2.55, db: -20 }])
    expect(buildViralEdit(decisionFor(f), f, { envelope: quiet }).stats.cuts).toBe(1)
    const withGame = buildViralEdit(decisionFor(f), f, { envelope: loud }).stats
    expect(withGame.cuts).toBe(0)
    expect(withGame.loudGapsKept).toBe(1)
  })

  it('cuts a pause over 0.7 s even with loud game sound', () => {
    const words: Word[] = [
      { t0: 0, t1: 0.3, text: 'so' },
      { t0: 0.35, t1: 0.65, text: 'watch' },
      { t0: 2, t1: 2.3, text: 'this' },
      { t0: 2.35, t1: 2.65, text: 'now' }
    ]
    const f = tightFacts(words)
    const loud = fineEnvelope(20, -50, [{ from: 0, to: 0.65, db: -20 }, { from: 2, to: 2.65, db: -20 }, { from: 0.65, to: 2, db: -22 }])
    expect(buildViralEdit(decisionFor(f), f, { envelope: loud }).stats.cuts).toBe(1)
  })

  it('trims leading silence over 0.3 s down to 0.15 s, and leaves a shorter one alone', () => {
    const f = tightFacts(speech(2, 10, 0.4))
    const { edl, stats } = buildViralEdit(decisionFor(f), f)
    expect(edl.segments[0]!.srcStart).toBeCloseTo(1.85, 6)
    expect(stats.firstEventSec).toBeCloseTo(2, 6)
    const g = tightFacts(speech(0.25, 10, 0.4))
    expect(buildViralEdit(decisionFor(g), g).edl.segments[0]!.srcStart).toBe(0)
  })

  it('finds the first reaction from loudness when there are no words', () => {
    const f = facts({ window: { start: 0, end: 20 } })
    const env = fineEnvelope(20, -45, [{ from: 3, to: 5, db: -15 }])
    const { edl, stats } = buildViralEdit(decisionFor(f), f, { envelope: env })
    expect(stats.firstEventSec).toBeCloseTo(3, 1)
    expect(edl.segments[0]!.srcStart).toBeCloseTo(2.85, 1)
  })

  it('keeps the reaction beat and about a second after it, and stops at the clip end', () => {
    const f = facts({ window: { start: 0, end: 30 }, words: speech(0, 10, 0.4), loudness: loudness(30, 12, 2, -5) })
    const { edl } = buildViralEdit(decisionFor(f), f)
    const end = edl.segments[edl.segments.length - 1]!.srcEnd
    // Peak second 12, the loud seconds run to 14: the end is that plus the 1 s run-out.
    expect(end).toBeGreaterThanOrEqual(12.5 + 1)
    expect(end).toBeLessThanOrEqual(30)
  })

  it('keeps everything when the edit is skipped (plain)', () => {
    const f = tightFacts(speech(2, 10, 0.4), 12)
    const { edl, stats } = buildViralEdit(decisionFor(f), f, { plain: true })
    expect(edl.segments).toEqual([{ srcStart: 0, srcEnd: 12, speed: 1 }])
    expect(stats.cuts).toBe(0)
  })

  it('ends a looped edit where it is told to', () => {
    const f = tightFacts(speech(0, 20, 0.4), 30)
    const { edl } = buildViralEdit(decisionFor(f), f, { loop: { endSec: 8.4, crossfadeSec: 0.06 } })
    expect(edl.segments[edl.segments.length - 1]!.srcEnd).toBeCloseTo(8.4, 6)
    expect(edl.ending).toEqual({ kind: 'loop', crossfadeSec: 0.06 })
  })
})

describe('coldOpenVariantEdl', () => {
  const plan = (over: Partial<ColdOpenPlan> = {}): ColdOpenPlan => ({
    qualifies: true,
    confidence: 0.9,
    llm: 'unavailable',
    payoffVodSec: 20,
    previewSec: 2,
    finalSec: 22,
    segments: [{ srcStart: 19, srcEnd: 21 }, { srcStart: 0, srcEnd: 20 }],
    capFit: capFit(22),
    reasons: [],
    ...over
  })
  const straight = () => {
    const f = tightFacts(speech(0, 45, 0.4), 20)
    return buildViralEdit({ ...pickStructure(computeSignals(f), f.words, 0), structure: 'tightCut' }, f, FAKE_SFX)
  }

  it('puts the preview first, a whoosh on the join, and shifts every cue by its length', () => {
    const { edl } = straight()
    const cold = coldOpenVariantEdl(edl, plan(), FAKE_SFX)!
    expect(cold.segments[0]).toEqual({ srcStart: 19, srcEnd: 21, speed: 1 })
    expect(cold.segments.slice(1)).toEqual(edl.segments)
    expect(outputDuration(cold)).toBeCloseTo(outputDuration(edl) + 2, 6)
    expect(cold.sfx.find((s) => s.file === 'whoosh.wav')!.t).toBeCloseTo(2, 6)
    const boom = edl.sfx.find((s) => s.file === 'boom.wav')!
    expect(cold.sfx.find((s) => s.file === 'boom.wav')!.t).toBeCloseTo(boom.t + 2, 6)
    expect(cold.zoom[0]).toEqual({ t: 0, scale: 1, ease: 'snap' })
    expect(validateEdl(cold, 22)).toEqual([])
  })

  it('never loops and returns null when the plan does not qualify', () => {
    const { edl } = straight()
    expect(coldOpenVariantEdl({ ...edl, ending: { kind: 'loop', crossfadeSec: 0.06 } }, plan())!.ending).toEqual({ kind: 'cut' })
    expect(coldOpenVariantEdl(edl, plan({ qualifies: false, segments: [] }))).toBeNull()
  })
})
