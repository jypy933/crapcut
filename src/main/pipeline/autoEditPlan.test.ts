// The moments-time half of the rule engine: growing short cuts from their
// padding, dropping the ones that still fall short, the content floor with a
// minimum of clips kept, and the language model being asked only when the
// deterministic gate would let a cold open through with its help.

import { describe, expect, it } from 'vitest'
import type { ChatMessage, Clip, Word } from '@shared/types'
import { planMomentEdits, type MomentPlanArgs } from './autoEditPlan'

/** A 0.3 s word every 0.5 s in [from, to). */
function speech(from: number, to: number): Word[] {
  const out: Word[] = []
  for (let t = from; t < to; t += 0.5) out.push({ t0: t, t1: t + 0.3, text: `w${out.length}` })
  return out
}

function chat(at: number, n = 12): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({ t: at + i * 0.2, user: `viewer${i}`, text: 'KEKW' }))
}

const NO_LOG = { info: () => {}, warn: () => {}, error: () => {} }
const messages: string[] = []
const LOG = { info: (...p: unknown[]) => void messages.push(p.join(' ')), warn: () => {}, error: () => {} }

function clip(id: string, start: number, end: number, over: Partial<Clip> = {}): Clip {
  return {
    id,
    jobId: 'job-1',
    rank: 1,
    score: 0.5,
    title: id,
    start,
    end,
    suggested: { start, end },
    source: null,
    status: 'pending',
    words: speech(start - 20, end + 20),
    captions: { enabled: true, y: 0.72, uppercase: true, styleId: 'clean' },
    chatMessages: chat(start + (end - start) / 2),
    chatOverlay: false,
    audio: 'original',
    musicPath: null,
    layoutId: null,
    formats: { vertical: true, horizontal: false },
    reason: '',
    signals: null,
    structureDecision: { structure: 'tightCut', loopEnding: false, emphasisWords: [], reasons: [] },
    autoEdit: true,
    ...over
  }
}

/** Per-second loudness for a 1000 s VOD: a quiet bed with a loud burst at `at`. */
function loudness(at: number): Float64Array {
  const out = new Float64Array(1000).fill(-45)
  for (let t = at; t < at + 3; t++) out[t] = -12
  return out
}

function args(over: Partial<MomentPlanArgs> = {}): MomentPlanArgs {
  return { loudness: loudness(520), durationSec: 1000, padSec: 20, complete: null, concurrency: 1, minKeep: 3, signal: new AbortController().signal, log: NO_LOG, ...over }
}

describe('planMomentEdits', () => {
  it('stores a plan on every clip and keeps a healthy one as it is', async () => {
    const { clips, dropped } = await planMomentEdits([clip('a', 500, 540)], args())
    expect(dropped).toBe(0)
    expect(clips[0]!.editPlan).toBeDefined()
    expect(clips[0]!.editPlan!.finalSec).toBeGreaterThanOrEqual(10)
    expect(clips[0]!.start).toBe(500)
    expect(clips[0]!.end).toBe(540)
    expect(clips[0]!.editPlan!.capFit.tiktok.fits).toBe(true)
  })

  it('grows a cut under the floor from its download padding', async () => {
    const { clips } = await planMomentEdits([clip('short', 500, 507)], args())
    expect(clips[0]!.end - clips[0]!.start).toBeGreaterThanOrEqual(10)
    expect(clips[0]!.start).toBeGreaterThanOrEqual(480)
    expect(clips[0]!.end).toBeLessThanOrEqual(527)
    expect(clips[0]!.editPlan!.extendedSec).toBeGreaterThan(0)
  })

  it('drops a clip that cannot reach the floor (no padding left in the VOD)', async () => {
    const tiny = clip('tiny', 0, 6)
    const { clips, dropped } = await planMomentEdits([tiny, clip('ok', 500, 540)], args({ padSec: 0, minKeep: 1 }))
    expect(dropped).toBe(1)
    expect(clips.map((c) => c.id)).toEqual(['ok'])
    expect(clips[0]!.rank).toBe(1)
  })

  it('drops a clip with no chat peak inside, but never below the minimum number of clips', async () => {
    const dead = (id: string, start: number): Clip => clip(id, start, start + 30, { chatMessages: [{ t: start + 5, user: 'a', text: 'hi' }] })
    const three = await planMomentEdits([clip('good', 500, 540), dead('d1', 600), dead('d2', 700)], args({ minKeep: 1 }))
    expect(three.clips.map((c) => c.id)).toEqual(['good'])
    expect(three.dropped).toBe(2)
    const kept = await planMomentEdits([clip('good', 500, 540), dead('d1', 600), dead('d2', 700)], args({ minKeep: 3 }))
    expect(kept.clips.map((c) => c.id)).toEqual(['good', 'd1', 'd2'])
    expect(kept.clips.map((c) => c.rank)).toEqual([1, 2, 3])
    // Kept, but the plan still says what the floor found.
    expect(kept.dropped).toBe(0)
  })

  it('keeps a clip picked for a loudness peak even with no chat peak and no speech', async () => {
    const silent = clip('loud', 600, 630, { chatMessages: [{ t: 605, user: 'a', text: 'hi' }], words: [], signals: { chatZ: 0, audioZ: 4, score: 0.6, rating: null, source: 'audio' } })
    const quiet = clip('quiet', 700, 730, { chatMessages: [{ t: 705, user: 'a', text: 'hi' }] })
    const { clips } = await planMomentEdits([clip('good', 500, 540), silent, quiet], args({ minKeep: 1, loudness: loudness(615) }))
    expect(clips.map((c) => c.id)).toEqual(['good', 'loud'])
  })

  it('keeps a chat-quiet transcript moment that has speech', async () => {
    const said = clip('said', 700, 730, { chatMessages: [], signals: { chatZ: 0, audioZ: 0, score: 0.6, rating: null, source: 'transcript' } })
    const quietChat = clip('said2', 800, 830, { chatMessages: [{ t: 805, user: 'a', text: 'hi' }], signals: { chatZ: 0, audioZ: 0, score: 0.6, rating: null, source: 'transcript' } })
    const chatty = clip('chatty', 900, 930, { chatMessages: [{ t: 905, user: 'a', text: 'hi' }] })
    const { clips } = await planMomentEdits([clip('good', 500, 540), said, quietChat, chatty], args({ minKeep: 1 }))
    expect(clips.map((c) => c.id)).toEqual(['good', 'said', 'said2'])
  })

  it('never drops a clip he already decided on, and logs the failed check instead', async () => {
    messages.length = 0
    const dead = (id: string, start: number, status: Clip['status']): Clip => clip(id, start, start + 30, { status, chatMessages: [{ t: start + 5, user: 'a', text: 'hi' }] })
    const tiny = clip('tiny-accepted', 0, 6, { status: 'accepted' })
    const { clips, dropped } = await planMomentEdits(
      [clip('good', 500, 540), dead('accepted-1', 600, 'accepted'), dead('rejected-1', 700, 'rejected'), dead('pending-1', 800, 'pending'), tiny],
      args({ minKeep: 1, padSec: 0, log: LOG })
    )
    expect(clips.map((c) => c.id)).toEqual(['good', 'accepted-1', 'rejected-1', 'tiny-accepted'])
    expect(clips.map((c) => c.rank)).toEqual([1, 2, 3, 4])
    expect(dropped).toBe(1)
    expect(messages.some((m) => m.includes('clip accepted:') && m.includes('content floor'))).toBe(true)
    expect(messages.some((m) => m.includes('clip tiny-acc') && m.includes('length floor'))).toBe(true)
  })

  it('logs each rule once per clip as one compact line', async () => {
    messages.length = 0
    await planMomentEdits([clip('abcdef123456', 500, 540)], args({ log: LOG }))
    const lines = messages.filter((m) => m.startsWith('rule '))
    expect(lines.map((l) => l.split(' ')[1])).toEqual(['length', 'content', 'hook', 'pacing', 'coldOpen', 'loop'])
    for (const l of lines) {
      expect(l).toContain('clip=abcdef12')
      expect(l).not.toContain('\n')
    }
  })

  it('asks the model about a cold open only when the deterministic gate would let it through with its help', async () => {
    // Payoff 20 s into a 40 s clip, chat peak 7 s later.
    const strong = clip('strong', 500, 540, { chatMessages: chat(527) })
    const calls: string[] = []
    const complete = async (prompt: string): Promise<string> => {
      calls.push(prompt)
      return '{"worthIt": true}'
    }
    const asked = await planMomentEdits([strong], args({ complete }))
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('Preview:')
    expect(asked.clips[0]!.editPlan!.coldOpen).toMatchObject({ qualifies: true, llm: 'confirmed' })

    // A clip whose payoff is at its very start never qualifies, so the model is not asked.
    calls.length = 0
    const early = clip('early', 500, 540, { chatMessages: chat(509) })
    await planMomentEdits([early], args({ complete, loudness: loudness(501) }))
    expect(calls.length).toBe(0)
  })

  it('takes the model saying no, or failing, without breaking the clip', async () => {
    const strong = clip('strong', 500, 540, { chatMessages: chat(527) })
    const no = await planMomentEdits([strong], args({ complete: async () => '{"worthIt": false}' }))
    expect(no.clips[0]!.editPlan!.coldOpen).toMatchObject({ qualifies: false, llm: 'rejected' })
    const down = await planMomentEdits([strong], args({ complete: async () => Promise.reject(new Error('down')) }))
    expect(down.clips[0]!.editPlan!.coldOpen.llm).toBe('unavailable')
    expect(down.clips.length).toBe(1)
  })

  it('keeps everything when the rules would otherwise leave nothing', async () => {
    const dead = clip('d1', 600, 630, { chatMessages: [] , words: [] })
    const { clips } = await planMomentEdits([dead], args({ minKeep: 0, loudness: new Float64Array(1000).fill(-100) }))
    expect(clips.length).toBe(1)
  })
})
