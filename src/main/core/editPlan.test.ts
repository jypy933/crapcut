import { describe, expect, it } from 'vitest'
import type { ChatMessage, Word } from '@shared/types'
import { planAutoEdit, growWindow, type PlanInput } from './editPlan'
import type { Envelope } from './editRules'
import { outputDuration, validateEdl } from './edl'
import { pickStructure } from './structurePick'
import { computeSignals, type ClipFacts } from './structureSignals'
import type { StructureDecision } from './structurePick'

/** A 0.3 s word every `gap` seconds from `from` (VOD seconds). */
function speech(from: number, to: number, gap = 0.5): Word[] {
  const out: Word[] = []
  for (let t = from; t < to; t += gap) out.push({ t0: t, t1: t + 0.3, text: `w${out.length}` })
  return out
}

/** A 0.1 s envelope from VOD second `start`: `base` dB, `speechDb` under every word, and a burst. */
function env(start: number, total: number, words: Word[], base: number, speechDb: number, burst?: { from: number; to: number; db: number }): Envelope {
  const db = new Array<number>(Math.round(total * 10)).fill(base)
  const at = (t: number): number => Math.round((t - start) * 10)
  for (const w of words) for (let i = at(w.t0); i < at(w.t1); i++) if (i >= 0 && i < db.length) db[i] = speechDb
  if (burst) for (let i = at(burst.from); i < at(burst.to); i++) if (i >= 0 && i < db.length) db[i] = burst.db
  return { startSec: start, stepSec: 0.1, db }
}

function chat(at: number, n = 12): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({ t: at + i * 0.2, user: `viewer${i}`, text: 'KEKW' }))
}

function decisionFor(f: ClipFacts, over: Partial<StructureDecision> = {}): StructureDecision {
  return { ...pickStructure(computeSignals(f), f.words, f.window.start), structure: 'tightCut', loopEnding: false, ...over }
}

/** A 30 s clip at VOD 100-130, words throughout, a loud burst with a chat peak, padded 20 s each side. */
function healthy(over: Partial<ClipFacts> = {}): { facts: ClipFacts; input: PlanInput } {
  const words = speech(80, 150)
  const facts: ClipFacts = { window: { start: 100, end: 130 }, words, chatMessages: chat(115), loudness: null, loudnessOffset: 0, ...over }
  const envelope = env(80, 70, words, -50, -20, { from: 110, to: 113, db: -8 })
  return { facts, input: { facts, decision: decisionFor(facts), bounds: { start: 80, end: 150 }, envelope } }
}

describe('growWindow', () => {
  it('grows half each side, inside the bounds', () => {
    expect(growWindow({ start: 100, end: 108 }, { start: 80, end: 130 }, 4)).toEqual({ start: 98, end: 110 })
  })
  it('passes what one side cannot give to the other', () => {
    expect(growWindow({ start: 81, end: 108 }, { start: 80, end: 130 }, 6)).toEqual({ start: 80, end: 113 })
    expect(growWindow({ start: 100, end: 129 }, { start: 80, end: 130 }, 6)).toEqual({ start: 95, end: 130 })
  })
  it('stops at the bounds', () => {
    expect(growWindow({ start: 100, end: 108 }, { start: 100, end: 108 }, 5)).toEqual({ start: 100, end: 108 })
    expect(growWindow({ start: 100, end: 108 }, { start: 99, end: 109 }, 5)).toEqual({ start: 99, end: 109 })
  })
})

describe('planAutoEdit: a healthy clip', () => {
  it('produces a valid straight edit at or over the floor, every rule reported once, and all platform caps fitting', () => {
    const { input } = healthy()
    const r = planAutoEdit(input)
    expect(validateEdl(r.edl, 30)).toEqual([])
    expect(r.drop).toBe(false)
    expect(r.plan.editSkipped).toBe(false)
    expect(r.plan.extendedSec).toBe(0)
    expect(r.plan.finalSec).toBeGreaterThanOrEqual(10)
    expect(r.plan.finalSec).toBeCloseTo(outputDuration(r.edl), 6)
    expect(r.plan.capFit.tiktok.fits && r.plan.capFit.shorts.fits && r.plan.capFit.reels.fits).toBe(true)
    expect(r.window).toEqual({ start: 100, end: 130 })
    expect(r.checks.map((c) => c.check)).toEqual(['length', 'content', 'hook', 'pacing', 'coldOpen', 'loop'])
    expect(r.checks.find((c) => c.check === 'length')!.status).toBe('pass')
    expect(r.contentOk).toBe(true)
    expect(r.checks.find((c) => c.check === 'hook')!.status).toBe('pass')
  })

  it('keeps the hook and content outcome on the plan for the virality score', () => {
    const r = planAutoEdit(healthy().input)
    expect(r.plan.hook).toEqual({ grade: expect.stringMatching(/^(soft|hard)$/), pass: true })
    expect(r.plan.content?.pass).toBe(true)
    expect(r.plan.content?.coverage).toBeGreaterThanOrEqual(0.4)
  })

  it('works with no language model and no loudness envelope at all (degraded)', () => {
    const { facts } = healthy()
    const r = planAutoEdit({ facts, decision: decisionFor(facts), bounds: { start: 80, end: 150 } })
    expect(r.plan.finalSec).toBeGreaterThan(0)
    expect(r.plan.coldOpen.llm).toBe('unavailable')
    expect(validateEdl(r.edl, 30)).toEqual([])
  })

  it('reports a cap miss for a long cut per platform', () => {
    const words = speech(50, 200)
    const facts: ClipFacts = { window: { start: 100, end: 175 }, words, chatMessages: chat(130), loudness: null, loudnessOffset: 0 }
    const r = planAutoEdit({ facts, decision: decisionFor(facts), bounds: { start: 80, end: 200 } })
    expect(r.plan.finalSec).toBeGreaterThan(60)
    expect(r.plan.capFit.tiktok.fits).toBe(false)
    expect(r.plan.capFit.shorts.fits).toBe(false)
    expect(r.plan.capFit.reels.fits).toBe(r.plan.finalSec <= 90)
  })
})

describe('planAutoEdit: the final-length floor (skip the edit, then extend, then drop)', () => {
  /** 12 s of words with a long pause in the middle, so the edit cuts it under 10 s. */
  function pausey(): { facts: ClipFacts; envelope: Envelope } {
    const words = [...speech(100, 104), ...speech(109.5, 112)]
    const facts: ClipFacts = { window: { start: 100, end: 112 }, words, chatMessages: chat(104), loudness: null, loudnessOffset: 0 }
    return { facts, envelope: env(80, 70, words, -50, -20, { from: 103, to: 104, db: -8 }) }
  }

  it('skips the edit, not the clip, when the edit alone would end under 10 s', () => {
    const { facts, envelope } = pausey()
    const edited = planAutoEdit({ facts, decision: decisionFor(facts), bounds: { start: 100, end: 112 }, envelope, options: {} })
    expect(edited.plan.editSkipped).toBe(true)
    expect(edited.plan.extendedSec).toBe(0)
    expect(edited.plan.finalSec).toBeCloseTo(12, 6)
    expect(edited.edl.segments).toEqual([{ srcStart: 0, srcEnd: 12, speed: 1 }])
    expect(edited.drop).toBe(false)
    expect(edited.checks.find((c) => c.check === 'length')).toMatchObject({ status: 'pass', values: { skippedEdit: true } })
  })

  it('grows the cut from the padding when even the plain cut is under 10 s', () => {
    const words = speech(80, 150)
    const facts: ClipFacts = { window: { start: 100, end: 107 }, words, chatMessages: chat(103), loudness: null, loudnessOffset: 0 }
    const r = planAutoEdit({ facts, decision: decisionFor(facts), bounds: { start: 80, end: 127 } })
    expect(r.plan.editSkipped).toBe(true)
    expect(r.plan.extendedSec).toBeGreaterThan(2.9)
    expect(r.window.start).toBeLessThan(100)
    expect(r.window.end).toBeGreaterThan(107)
    expect(r.window.start).toBeGreaterThanOrEqual(80)
    expect(r.window.end).toBeLessThanOrEqual(127)
    expect(r.plan.finalSec).toBeGreaterThanOrEqual(10)
    expect(r.drop).toBe(false)
    expect(r.plan.belowFloor).toBe(false)
  })

  it('drops the clip only when it still falls short with nothing left to grow into', () => {
    const words = speech(100, 107)
    const facts: ClipFacts = { window: { start: 100, end: 107 }, words, chatMessages: chat(103), loudness: null, loudnessOffset: 0 }
    const r = planAutoEdit({ facts, decision: decisionFor(facts), bounds: { start: 100, end: 107 } })
    expect(r.drop).toBe(true)
    expect(r.plan.belowFloor).toBe(true)
    expect(r.checks.find((c) => c.check === 'length')!.status).toBe('fail')
  })

  it('extends by only as much as it needs', () => {
    const words = speech(80, 150)
    const facts: ClipFacts = { window: { start: 100, end: 108 }, words, chatMessages: chat(103), loudness: null, loudnessOffset: 0 }
    const r = planAutoEdit({ facts, decision: decisionFor(facts), bounds: { start: 60, end: 150 } })
    expect(r.plan.extendedSec).toBeLessThan(2.2)
    expect(r.plan.finalSec).toBeLessThan(10.2)
  })
})

describe('planAutoEdit: the content floor', () => {
  it('fails a clip with no chat peak inside when there is chat, and one with too little speech or loudness', () => {
    const noPeak = healthy({ chatMessages: [{ t: 105, user: 'a', text: 'hi' }] })
    const r = planAutoEdit(noPeak.input)
    expect(r.contentOk).toBe(false)
    expect(r.checks.find((c) => c.check === 'content')!.values.chatPeaks).toBe(0)

    // No transcript and mostly silence: only a few loud seconds to cover the edit.
    const facts: ClipFacts = { window: { start: 100, end: 130 }, words: [], chatMessages: chat(115), loudness: null, loudnessOffset: 0 }
    const quiet = env(100, 30, [], -100, -20, { from: 110, to: 116, db: -20 })
    const sparse = planAutoEdit({ facts, decision: decisionFor(facts), bounds: { start: 100, end: 130 }, envelope: quiet })
    expect(sparse.checks.find((c) => c.check === 'content')!.values.coverage as number).toBeLessThan(0.4)
    expect(sparse.contentOk).toBe(false)
  })

  it('never drops a loud moment for lacking chat: a loudness peak passes without a chat peak', () => {
    const noPeak = healthy({ chatMessages: [{ t: 105, user: 'a', text: 'hi' }] })
    expect(planAutoEdit(noPeak.input).contentOk).toBe(false)
    const loud = planAutoEdit({ ...noPeak.input, loudPeak: true })
    expect(loud.contentOk).toBe(true)
    expect(loud.checks.find((c) => c.check === 'content')!.values.loudPeak).toBe(true)
  })

  it('judges only the coverage when there is no chat replay at all', () => {
    const { input } = healthy({ chatMessages: [] })
    const r = planAutoEdit(input)
    expect(r.checks.find((c) => c.check === 'content')!.values.chatPeaks).toBeNull()
    expect(r.contentOk).toBe(true)
  })
})

describe('planAutoEdit: cold open plan', () => {
  it('stores a plan with segments, confidence and per-platform fit, and builds the second version from it, without touching the straight edit', () => {
    const { input } = healthy()
    const straight = planAutoEdit(input)
    const r = planAutoEdit({ ...input, llm: 'confirmed' })
    expect(r.plan.coldOpen.qualifies).toBe(true)
    expect(r.plan.coldOpen.llm).toBe('confirmed')
    expect(r.plan.coldOpen.confidence).toBeGreaterThan(0.55)
    expect(r.plan.coldOpen.segments.length).toBe(1 + r.edl.segments.length)
    expect(r.plan.coldOpen.capFit.tiktok.fits).toBe(true)
    expect(r.coldOpenEdl).not.toBeNull()
    expect(outputDuration(r.coldOpenEdl!)).toBeCloseTo(r.plan.coldOpen.finalSec, 6)
    expect(validateEdl(r.coldOpenEdl!, 30)).toEqual([])
    // The default edit is the same straight cut either way.
    expect(r.edl).toEqual(straight.edl)
    expect(r.checks.find((c) => c.check === 'coldOpen')!.status).toBe('pass')
  })

  it('a payoffFirst clip never gets one: it already opens on its payoff', () => {
    const words = speech(80, 150)
    const facts: ClipFacts = { window: { start: 100, end: 130 }, words, chatMessages: chat(104), loudness: null, loudnessOffset: 0 }
    const r = planAutoEdit({ facts, decision: decisionFor(facts, { structure: 'payoffFirst' }), bounds: { start: 80, end: 150 }, envelope: env(80, 70, words, -50, -20, { from: 101, to: 104, db: -8 }), llm: 'confirmed' })
    expect(r.plan.coldOpen.qualifies).toBe(false)
    expect(r.coldOpenEdl).toBeNull()
    expect(r.checks.find((c) => c.check === 'coldOpen')!.status).toBe('na')
  })

  it('keeps an earlier model verdict while the payoff has not moved, and forgets it once it has', () => {
    const { input } = healthy()
    const first = planAutoEdit({ ...input, llm: 'confirmed' })
    expect(planAutoEdit({ ...input, previous: first.plan }).plan.coldOpen.llm).toBe('confirmed')
    const moved = { ...first.plan, coldOpen: { ...first.plan.coldOpen, payoffVodSec: (first.plan.coldOpen.payoffVodSec ?? 0) + 5 } }
    expect(planAutoEdit({ ...input, previous: moved }).plan.coldOpen.llm).toBe('unavailable')
  })
})

describe('planAutoEdit: loop', () => {
  /** A 14 s clip of steady speech, then quiet: a candidate loop end (final length under 30 s). */
  function loopable(): PlanInput {
    const words = speech(100, 113.6)
    const facts: ClipFacts = { window: { start: 100, end: 116 }, words: [...words, ...speech(140, 150)], chatMessages: chat(106), loudness: null, loudnessOffset: 0 }
    return { facts, decision: decisionFor(facts, { structure: 'freezeLoop', loopEnding: true }), bounds: { start: 80, end: 150 }, envelope: env(80, 70, words, -50, -20, { from: 104, to: 106, db: -8 }) }
  }

  it('asks for a seam measurement where a loop could end, and stays a plain cut without one', () => {
    const r = planAutoEdit(loopable())
    expect(r.seamProbe).not.toBeNull()
    expect(r.plan.loop.eligible).toBe(false)
    expect(r.plan.loop.seamScore).toBeNull()
    expect(r.plan.loop.endSec).toBe(r.seamProbe!.endSec)
    expect(r.edl.ending).toEqual({ kind: 'cut' })
    expect(r.plan.loop.calibrated).toBe(false)
  })

  it('loops when the structure wants one and the seam passes: a hard cut, 30-100 ms audio crossfade, ending on the quiet after the last word', () => {
    const input = loopable()
    const probe = planAutoEdit(input).seamProbe!
    const r = planAutoEdit({ ...input, seam: { frameSimilarity: 0.8, loudnessDiffLu: 1.2 } })
    expect(r.seamProbe).toBeNull()
    expect(r.plan.loop).toMatchObject({ eligible: true, seamScore: 0.8, loudnessDiffLu: 1.2 })
    expect(r.edl.ending.kind).toBe('loop')
    if (r.edl.ending.kind === 'loop') {
      expect(r.edl.ending.crossfadeSec).toBeGreaterThanOrEqual(0.03)
      expect(r.edl.ending.crossfadeSec).toBeLessThanOrEqual(0.1)
    }
    expect(r.edl.segments[r.edl.segments.length - 1]!.srcEnd).toBeCloseTo(probe.endSec, 6)
    expect(r.plan.finalSec).toBeLessThanOrEqual(30)
    expect(r.checks.find((c) => c.check === 'loop')!.status).toBe('pass')
  })

  it('is eligible on the plan but leaves the straight edit alone when the structure did not ask for a loop (a property of a version)', () => {
    const input = loopable()
    const r = planAutoEdit({ ...input, decision: decisionFor(input.facts), seam: { frameSimilarity: 0.8, loudnessDiffLu: 1.2 } })
    expect(r.plan.loop.eligible).toBe(true)
    expect(r.edl.ending).toEqual({ kind: 'cut' })
  })

  it('does not loop when the seam fails on frames or loudness', () => {
    const input = loopable()
    const badFrames = planAutoEdit({ ...input, seam: { frameSimilarity: 0.3, loudnessDiffLu: 1 } })
    expect(badFrames.plan.loop.eligible).toBe(false)
    expect(badFrames.plan.loop.seamScore).toBe(0.3)
    expect(badFrames.edl.ending).toEqual({ kind: 'cut' })
    expect(badFrames.checks.find((c) => c.check === 'loop')!.status).toBe('fail')
    expect(planAutoEdit({ ...input, seam: { frameSimilarity: 0.9, loudnessDiffLu: 5 } }).edl.ending).toEqual({ kind: 'cut' })
  })

  it('has no loop candidate over 30 s, or when the edit was skipped for the floor', () => {
    const { input } = healthy()
    const long = planAutoEdit({ ...input, decision: decisionFor(input.facts, { structure: 'freezeLoop', loopEnding: true }) })
    expect(long.plan.finalSec).toBeGreaterThan(20)
    expect(planAutoEdit({ ...loopable(), facts: { ...loopable().facts, window: { start: 100, end: 108 } } }).plan.loop.eligible).toBe(false)
  })
})
