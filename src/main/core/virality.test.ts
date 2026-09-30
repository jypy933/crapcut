import { describe, expect, it } from 'vitest'
import type { ClipEditPlan } from '@shared/editPlan'
import type { ChatMessage, Clip, Word } from '@shared/types'
import { DEFAULT_TASTE_ADJUSTMENTS } from './taste'
import { formatViralityLine, orderBestFirst, pickTopScores, rankClips, scoreClip, VIRALITY, withLegacyScore } from './virality'

function words(start: number, n: number): Word[] {
  return Array.from({ length: n }, (_, i) => ({ t0: start + i * 0.4, t1: start + i * 0.4 + 0.3, text: i % 5 === 4 ? 'word.' : 'word' }))
}

/** Reaction messages from `n` different people around `at`. */
function burst(at: number, n: number, text = 'KEKW'): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({ t: at + i * 0.3, user: `user${i}`, text }))
}

function plan(over: Partial<ClipEditPlan> = {}): ClipEditPlan {
  const cap = { capSec: 60, fits: true }
  return {
    finalSec: 25,
    editSkipped: false,
    extendedSec: 0,
    belowFloor: false,
    capFit: { tiktok: cap, shorts: cap, reels: cap },
    coldOpen: { qualifies: false, confidence: 0, llm: 'unavailable', payoffVodSec: null, previewSec: 0, finalSec: 0, segments: [], capFit: { tiktok: cap, shorts: cap, reels: cap }, reasons: [] },
    loop: { eligible: false, endSec: null, seamScore: null, loudnessDiffLu: null, quietSec: null, calibrated: false },
    hook: { grade: 'soft', pass: true },
    content: { pass: true, coverage: 0.7 },
    ...over
  }
}

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-abcdef123',
    jobId: 'job-1',
    rank: 1,
    score: 0.5,
    title: 't',
    start: 100,
    end: 128,
    suggested: { start: 100, end: 128 },
    source: null,
    status: 'pending',
    words: words(100.5, 30),
    captions: { enabled: true, y: 0.7, uppercase: true, styleId: 'clean' },
    chatMessages: [],
    chatOverlay: false,
    audio: 'original',
    musicPath: null,
    layoutId: null,
    formats: { vertical: true, horizontal: false },
    reason: '',
    signals: { chatZ: 0, audioZ: 0, score: 0.3, rating: null, source: 'chat' },
    structureDecision: null,
    autoEdit: true,
    editPlan: plan(),
    ...over
  }
}

const withSignals = (over: Partial<NonNullable<Clip['signals']>>): Clip['signals'] => ({ chatZ: 0, audioZ: 0, score: 0.3, rating: null, source: 'chat', ...over })

describe('scoreClip', () => {
  it('stays within 0..1 and the weights add up to 1', () => {
    const w = Object.values(VIRALITY.weights).reduce((a, b) => a + b, 0)
    expect(w).toBeCloseTo(1, 6)
    const best = scoreClip(clip({ signals: withSignals({ chatZ: 30, audioZ: 30, rating: 10 }), chatMessages: burst(115, 20) })).score
    const worst = scoreClip(clip({ signals: withSignals({}), words: [], editPlan: plan({ hook: { grade: 'late', pass: false }, content: { pass: false, coverage: 0 } }) })).score
    expect(best).toBeLessThanOrEqual(1)
    expect(worst).toBeGreaterThanOrEqual(0)
    expect(best).toBeGreaterThan(worst)
  })

  it('ranks a big chat reaction above a quiet one', () => {
    const big = scoreClip(clip({ signals: withSignals({ chatZ: 8 }), chatMessages: burst(112, 12) })).score
    const small = scoreClip(clip({ signals: withSignals({ chatZ: 2.6 }), chatMessages: burst(112, 3) })).score
    expect(big).toBeGreaterThan(small)
  })

  it('counts distinct chatters, so one user flooding cannot fake a crowd', () => {
    const flood: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({ t: 112 + i * 0.2, user: 'spammer', text: 'KEKW' }))
    const crowd = burst(112, 6)
    const a = scoreClip(clip({ signals: withSignals({ chatZ: 3 }), chatMessages: flood }))
    const b = scoreClip(clip({ signals: withSignals({ chatZ: 3 }), chatMessages: crowd }))
    expect(b.factors.chat).toBeGreaterThan(a.factors.chat)
  })

  it('lets a small chat count: a handful of different people laughing is a real reaction', () => {
    const laugh = scoreClip(clip({ signals: withSignals({ chatZ: 2.6 }), chatMessages: burst(112, 4, 'LUL') }))
    const idle = scoreClip(clip({ signals: withSignals({ chatZ: 2.6 }), chatMessages: burst(112, 4, 'ok sure yes') }))
    expect(laugh.factors.chat).toBeGreaterThan(idle.factors.chat)
  })

  it('does not drop a loud moment for lacking speech or chat: silent loud reactions still score high', () => {
    const silent = scoreClip(clip({ signals: withSignals({ audioZ: 6, source: 'audio' }), words: [], chatMessages: [], editPlan: plan({ content: { pass: true, coverage: 0.5 } }) }))
    expect(silent.factors.loud).toBeGreaterThan(0.7)
    expect(silent.score).toBeGreaterThan(VIRALITY.topPick.floor)
    const flat = scoreClip(clip({ signals: withSignals({ source: 'audio' }), words: [], chatMessages: [] }))
    expect(silent.score).toBeGreaterThan(flat.score)
  })

  it('lets chat and loudness agreeing lift a clip above either alone', () => {
    const chatOnly = scoreClip(clip({ signals: withSignals({ chatZ: 5 }), chatMessages: burst(112, 8) }))
    const both = scoreClip(clip({ signals: withSignals({ chatZ: 5, audioZ: 5 }), chatMessages: burst(112, 8) }))
    expect(both.factors.evidence).toBeGreaterThan(chatOnly.factors.evidence)
    expect(both.score).toBeGreaterThan(chatOnly.score)
  })

  it('reads hook and content from the edit plan and stays neutral without one', () => {
    const good = scoreClip(clip({ signals: withSignals({ chatZ: 4 }), editPlan: plan() }))
    const late = scoreClip(clip({ signals: withSignals({ chatZ: 4 }), editPlan: plan({ hook: { grade: 'late', pass: false }, content: { pass: false, coverage: 0.2 } }) }))
    const none = scoreClip(clip({ signals: withSignals({ chatZ: 4 }), editPlan: undefined }))
    expect(good.score).toBeGreaterThan(late.score)
    expect(none.factors.hook).toBe(VIRALITY.neutral)
    expect(none.factors.content).toBe(VIRALITY.neutral)
    expect(none.score).toBeLessThan(good.score)
    expect(none.score).toBeGreaterThan(late.score - 0.1)
  })

  it('adds cold-open and loop only as small bonuses', () => {
    const base = scoreClip(clip({ signals: withSignals({ chatZ: 4 }) }))
    const bonus = scoreClip(
      clip({
        signals: withSignals({ chatZ: 4 }),
        editPlan: plan({ coldOpen: { ...plan().coldOpen, qualifies: true, confidence: 1 }, loop: { ...plan().loop, eligible: true } })
      })
    )
    const gain = bonus.score - base.score
    expect(gain).toBeGreaterThan(0)
    expect(gain).toBeLessThanOrEqual(VIRALITY.weights.coldOpen + VIRALITY.weights.loop + 1e-9)
  })

  it('blends the model rating in only when present', () => {
    const c = clip({ signals: withSignals({ chatZ: 4, rating: null }) })
    const none = scoreClip(c)
    expect(none.factors.llm).toBeNull()
    expect(scoreClip({ ...c, signals: withSignals({ chatZ: 4, rating: 9 }) }).score).toBeGreaterThan(none.score)
    expect(scoreClip({ ...c, signals: withSignals({ chatZ: 4, rating: 4 }) }).score).toBeLessThan(none.score)
  })

  it('lets the taste model nudge by source, and is a no-op without history', () => {
    const c = clip({ signals: withSignals({ chatZ: 4, source: 'chat' }), chatMessages: burst(112, 6) })
    const plain = scoreClip(c)
    expect(scoreClip(c, DEFAULT_TASTE_ADJUSTMENTS).score).toBeCloseTo(plain.score, 9)
    const liked = scoreClip(c, { ...DEFAULT_TASTE_ADJUSTMENTS, chatWeight: 1.4 })
    const disliked = scoreClip(c, { ...DEFAULT_TASTE_ADJUSTMENTS, chatWeight: 0.6 })
    expect(liked.score).toBeGreaterThan(plain.score)
    expect(disliked.score).toBeLessThan(plain.score)
    expect(liked.factors.taste).toBeGreaterThan(1)
  })

  it('prefers a clear setup and payoff over one that peaks at the very end', () => {
    // The loudness-less peak comes from chat: put the burst early vs at the end.
    const mid = scoreClip(clip({ signals: withSignals({ chatZ: 4 }), chatMessages: burst(112, 6) }))
    const late = scoreClip(clip({ signals: withSignals({ chatZ: 4 }), chatMessages: burst(127.5, 6) }))
    expect(mid.factors.payoff).toBeGreaterThan(late.factors.payoff)
  })

  it('works on a clip saved before signals or an edit plan existed', () => {
    const old = scoreClip(clip({ signals: null, editPlan: undefined, chatMessages: [] }))
    expect(old.score).toBeGreaterThanOrEqual(0)
    expect(old.score).toBeLessThanOrEqual(1)
    expect(Number.isFinite(old.score)).toBe(true)
  })
})

describe('pickTopScores', () => {
  it('picks nothing for a job of weak clips and never fills a fixed count', () => {
    expect(pickTopScores([0.3, 0.35, 0.4, 0.42, 0.38])).toEqual([false, false, false, false, false])
    expect(pickTopScores([])).toEqual([])
  })

  it('uses the absolute floor alone for a very small job', () => {
    expect(pickTopScores([0.7])).toEqual([true])
    expect(pickTopScores([0.7, 0.4])).toEqual([true, false])
    expect(pickTopScores([0.4, 0.3])).toEqual([false, false])
  })

  it('adapts to the job: only clips clear of the job middle, above the floor', () => {
    const scores = [0.9, 0.85, 0.6, 0.58, 0.56, 0.57, 0.55, 0.9]
    const picks = pickTopScores(scores)
    expect(picks.filter(Boolean).length).toBeGreaterThan(0)
    expect(picks.filter(Boolean).length).toBeLessThan(scores.length)
    expect(picks[0]).toBe(true)
    expect(picks[6]).toBe(false)
  })

  it('always eligible for the best clip when it clears the floor', () => {
    const picks = pickTopScores([0.56, 0.2, 0.2, 0.2, 0.2, 0.2])
    expect(picks[0]).toBe(true)
  })

  it('picks more clips from a stream where many are good', () => {
    const few = pickTopScores([0.9, 0.5, 0.5, 0.45, 0.45, 0.4, 0.4, 0.35]).filter(Boolean).length
    const many = pickTopScores([0.9, 0.85, 0.8, 0.78, 0.5, 0.45, 0.4, 0.35]).filter(Boolean).length
    expect(many).toBeGreaterThan(few)
  })
})

describe('rankClips', () => {
  const strong = (id: string): Clip => clip({ id, signals: withSignals({ chatZ: 8, audioZ: 5 }), chatMessages: burst(112, 12) })
  const weak = (id: string): Clip => clip({ id, signals: withSignals({ chatZ: 2.6 }), chatMessages: burst(112, 3, 'ok'), editPlan: plan({ hook: { grade: 'late', pass: false } }) })

  it('orders best first, renumbers ranks and accepts only the strong ones', () => {
    const { clips, lines } = rankClips([weak('w1'), strong('s1'), weak('w2'), weak('w3'), strong('s2')])
    expect(clips.map((c) => c.id.slice(0, 2))).toEqual(expect.arrayContaining(['s1', 's2']))
    expect(clips[0]!.id.startsWith('s')).toBe(true)
    expect(clips.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5])
    expect(clips.filter((c) => c.virality?.topPick).map((c) => c.id).sort()).toEqual(['s1', 's2'])
    for (const c of clips) expect(c.status).toBe(c.virality?.topPick ? 'accepted' : 'pending')
    expect(lines).toHaveLength(5)
  })

  it('never overrides a decision he already made', () => {
    const { clips } = rankClips([{ ...strong('s1'), status: 'rejected' }, weak('w1')])
    expect(clips.find((c) => c.id === 's1')!.status).toBe('rejected')
  })

  it('accepts none when the whole job is weak', () => {
    const { clips } = rankClips([weak('a'), weak('b'), weak('c')])
    expect(clips.every((c) => c.status === 'pending' && !c.virality?.topPick)).toBe(true)
  })

  it('keeps the order of equal scores', () => {
    const { clips } = rankClips([weak('a'), weak('b'), weak('c')])
    expect(clips.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('legacy clips', () => {
  it('scores without pre-selecting and orders best first', () => {
    const a = withLegacyScore(clip({ id: 'a', rank: 1, signals: withSignals({ chatZ: 2.6 }), chatMessages: burst(112, 3, 'ok') }))
    const b = withLegacyScore(clip({ id: 'b', rank: 2, signals: withSignals({ chatZ: 9, audioZ: 5 }), chatMessages: burst(112, 12) }))
    expect(a.virality?.topPick).toBe(false)
    expect(a.status).toBe('pending')
    const ordered = orderBestFirst([a, b])
    expect(ordered.map((c) => c.id)).toEqual(['b', 'a'])
    expect(ordered.map((c) => c.rank)).toEqual([1, 2])
  })
})

describe('formatViralityLine', () => {
  it('is one compact line with the score, the pick and every factor', () => {
    const s = scoreClip(clip({ signals: withSignals({ chatZ: 4, rating: 8 }), chatMessages: burst(112, 6) }))
    const line = formatViralityLine('clip-abc', s, true)
    expect(line.startsWith('virality clip=clip-abc score=')).toBe(true)
    expect(line).toContain('pick=yes')
    for (const k of ['chat=', 'loud=', 'evid=', 'payoff=', 'hook=', 'content=', 'cold=', 'loop=', 'llm=', 'taste=']) expect(line).toContain(k)
    expect(line).not.toContain('\n')
  })

  it('shows a dash for a missing model rating', () => {
    expect(formatViralityLine('x', scoreClip(clip()), false)).toContain('llm=-')
  })
})
