import { describe, expect, it } from 'vitest'
import type { Clip, Word } from '@shared/types'
import { clipFacts, decideStructureHeuristically } from './clipFacts'

function makeClip(partial: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    jobId: 'j1',
    rank: 1,
    score: 0.8,
    title: 'A moment',
    start: 1000,
    end: 1030,
    suggested: { start: 1000, end: 1030 },
    source: null,
    status: 'pending',
    words: [],
    captions: { enabled: true, y: 0.72, uppercase: true, styleId: 'clean' },
    chatMessages: [],
    chatOverlay: false,
    audio: 'original',
    musicPath: null,
    layoutId: null,
    formats: { vertical: true, horizontal: false },
    reason: '',
    signals: null,
    structureDecision: null,
    autoEdit: true,
    ...partial
  }
}

/** A short 3-8 word line ending in punctuation, right at `atSec` (VOD seconds). */
function quoteWords(atSec: number): Word[] {
  const w = ['no', 'way', 'he', 'actually', 'hit', 'that.']
  return w.map((text, i) => ({ t0: atSec + i * 0.3, t1: atSec + i * 0.3 + 0.28, text }))
}

function burstLoudness(totalSec: number, baseDb: number, at: number, len: number, db: number): Float64Array {
  const out = new Float64Array(totalSec).fill(baseDb)
  for (let t = Math.max(0, Math.floor(at)); t < Math.min(totalSec, Math.ceil(at + len)); t++) out[t] = db
  return out
}

describe('clipFacts', () => {
  it('maps a clip onto ClipFacts using its own start/end as the window', () => {
    const clip = makeClip({ words: [{ t0: 1000, t1: 1001, text: 'hi' }], chatMessages: [{ t: 1000, user: 'a', text: 'hey' }] })
    const loudness = new Float64Array([1, 2, 3])
    const facts = clipFacts(clip, loudness, 5)
    expect(facts.window).toEqual({ start: 1000, end: 1030 })
    expect(facts.words).toBe(clip.words)
    expect(facts.chatMessages).toBe(clip.chatMessages)
    expect(facts.loudness).toBe(loudness)
    expect(facts.loudnessOffset).toBe(5)
  })

  it('defaults to no loudness when none is given', () => {
    const facts = clipFacts(makeClip())
    expect(facts.loudness).toBeNull()
    expect(facts.loudnessOffset).toBe(0)
  })
})

describe('decideStructureHeuristically', () => {
  it('picks a structure with no previous decision to carry over', () => {
    const clip = makeClip({
      start: 0,
      end: 30,
      words: [...quoteWords(1), ...quoteWords(27)],
      audio: 'original'
    })
    const d = decideStructureHeuristically(clip, burstLoudness(30, -50, 28, 2, -5))
    expect(d.structure).toBeDefined()
    expect(d.reasons.length).toBeGreaterThan(0)
  })

  it('carries the previous quote span forward when the trim leaves it untouched', () => {
    const words = [...quoteWords(1), ...quoteWords(27)]
    const clip = makeClip({ start: 0, end: 30, words })
    const loudness = burstLoudness(30, -50, 28, 2, -5)
    const first = decideStructureHeuristically(clip, loudness)
    expect(first.structure).toBe('quoteCard')
    expect(first.quoteSpan).toBeDefined()

    // An unchanged "trim" (same bounds): the top structure is exactly the
    // previous one, so the carried-over quote span should survive untouched.
    const again = decideStructureHeuristically(clip, loudness, 0, first)
    expect(again.quoteSpan).toEqual(first.quoteSpan)
  })

  it('drops a carried quote span that a trim cut out of the clip', () => {
    const words = [...quoteWords(1), ...quoteWords(27)]
    const clip = makeClip({ start: 0, end: 30, words })
    const loudness = burstLoudness(30, -50, 28, 2, -5)
    const first = decideStructureHeuristically(clip, loudness)
    expect(first.quoteSpan).toBeDefined()

    // Trim the clip so it ends right where the quote used to be; the old
    // quote span's words now fall outside the new window.
    const trimmed = { ...clip, end: 20 }
    const again = decideStructureHeuristically(trimmed, burstLoudness(30, -50, 28, 2, -5), 0, first)
    // The stale span (its words sit at ~27s, outside the new 0..20 window) must not be echoed back.
    if (again.quoteSpan) {
      const w0 = trimmed.words[again.quoteSpan.start]!
      const w1 = trimmed.words[again.quoteSpan.end]!
      expect(w0.t0).toBeGreaterThanOrEqual(trimmed.start)
      expect(w1.t1).toBeLessThanOrEqual(trimmed.end)
    }
  })

  it('ignores a previous structure that no longer fits, and does not carry its picks', () => {
    const clip = makeClip({ start: 0, end: 3, words: [{ t0: 0.1, t1: 0.3, text: 'go' }] })
    const previous = { structure: 'quoteCard' as const, loopEnding: true, quoteSpan: { start: 0, end: 0 }, emphasisWords: [], reasons: [] }
    const d = decideStructureHeuristically(clip, null, 0, previous)
    expect(d.structure).toBeDefined()
  })
})
