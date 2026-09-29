import { describe, expect, it } from 'vitest'
import type { Candidate } from './moments'
import { buildPrompt, buildScanPrompt, cleanTitle, scanWindows, combinedScore, combineSamples, excerptLines, excerptRange, parseAnswer, ratingFactor, topChat, type Excerpt, type Refined } from './llmPrompt'

const cand: Candidate = {
  peak: 1010,
  event: 1000,
  window: { start: 982, end: 1013 },
  strength: 8,
  score: 0.7,
  chatZ: 7,
  audioZ: 2,
  reasons: ['Chat spike', 'laughter']
}

const words = [
  { t0: 960, t1: 960.4, text: 'okay' },
  { t0: 960.4, t1: 960.8, text: 'watch' },
  { t0: 962, t1: 962.3, text: 'this' },
  { t0: 1001, t1: 1001.5, text: 'NO' },
  { t0: 1001.5, t1: 1002, text: 'WAY!' }
]

describe('excerpt', () => {
  it('builds relative transcript lines split at pauses', () => {
    expect(excerptLines(words, { start: 955, end: 1035 })).toEqual(['[5.0] okay watch', '[7.0] this', '[46.0] NO WAY!'])
  })
  it('covers context before and reaction after', () => {
    expect(excerptRange(cand, 5000)).toEqual({ start: 955, end: 1035 })
    expect(excerptRange({ ...cand, event: 10, peak: 15 }, 30)).toEqual({ start: 0, end: 30 })
  })
  it('summarises repeated chat', () => {
    const msgs = [
      { t: 1005, user: 'a', text: 'KEKW' },
      { t: 1006, user: 'b', text: 'KEKW' },
      { t: 1007, user: 'c', text: 'lol' },
      { t: 2000, user: 'd', text: 'late' }
    ]
    expect(topChat(msgs, { start: 1000, end: 1020 })).toEqual(['"KEKW" ×2', '"lol"'])
  })
})

describe('buildPrompt', () => {
  it('includes the context, transcript and task', () => {
    const ex: Excerpt = { offset: 955, range: { start: 955, end: 1035 }, lines: ['[5.0] okay watch'] }
    const p = buildPrompt({ title: 'Big "stream"\nday', channel: 'someone', chapter: 'Elden Ring' }, cand, ex, ['"KEKW" ×2'])
    expect(p).toContain('Big  stream day')
    expect(p).toContain('playing: Elden Ring')
    expect(p).toContain('[5.0] okay watch')
    expect(p).toContain('"KEKW" ×2')
    expect(p).toContain('JSON')
  })

  it('includes two worked examples, one kept and one skipped', () => {
    const ex: Excerpt = { offset: 955, range: { start: 955, end: 1035 }, lines: [] }
    const p = buildPrompt({ title: 't', channel: 'c', chapter: null }, cand, ex, [])
    expect(p).toContain('"keep": true')
    expect(p).toContain('"keep": false')
  })
})

describe('parseAnswer', () => {
  const ex: Excerpt = { offset: 955, range: { start: 955, end: 1035 }, lines: [] }

  it('maps excerpt times back to the VOD', () => {
    const r = parseAnswer('{"keep":true,"rating":8,"start":5,"end":50,"title":"He did NOT see that coming"}', ex, 5000)
    expect(r).toEqual({ keep: true, rating: 8, window: { start: 960, end: 1005 }, title: 'He did NOT see that coming' })
  })

  it('fixes swapped, too short, too long and out-of-range times', () => {
    expect(parseAnswer('{"keep":true,"rating":7,"start":50,"end":5,"title":"x y"}', ex, 5000)!.window).toEqual({ start: 960, end: 1005 })
    const short = parseAnswer('{"keep":true,"rating":7,"start":20,"end":22,"title":"x y"}', ex, 5000)!.window
    expect(short.end - short.start).toBeCloseTo(12)
    const long = parseAnswer('{"keep":true,"rating":7,"start":-30,"end":500,"title":"x y"}', ex, 5000)!.window
    expect(long.start).toBe(955)
    expect(long.end - long.start).toBeLessThanOrEqual(60)
  })

  it('tolerates text around the JSON and clamps the rating', () => {
    const r = parseAnswer('Sure! {"keep":false,"rating":14,"start":1,"end":20,"title":"#clip \\"Wow\\""} thanks', ex, 5000)
    expect(r).toMatchObject({ keep: false, rating: 10, title: 'Wow' })
  })

  it('rejects broken answers', () => {
    expect(parseAnswer('not json', ex, 5000)).toBeNull()
    expect(parseAnswer('{"keep":"yes"}', ex, 5000)).toBeNull()
    expect(parseAnswer('{"keep":true,"rating":5,"start":"a","end":2,"title":"t"}', ex, 5000)).toBeNull()
  })
})

describe('combineSamples', () => {
  const base: Refined = { keep: true, rating: 8, window: { start: 10, end: 20 }, title: 'A' }

  it('keeps a candidate only when both samples agree', () => {
    expect(combineSamples(base, { ...base, rating: 6 })!.keep).toBe(true)
    expect(combineSamples(base, { ...base, keep: false })!.keep).toBe(false)
    expect(combineSamples({ ...base, keep: false }, { ...base, keep: false })!.keep).toBe(false)
  })

  it('averages the rating and window from both samples', () => {
    const r = combineSamples(base, { ...base, rating: 6, window: { start: 12, end: 24 } })!
    expect(r.rating).toBe(7)
    expect(r.window).toEqual({ start: 11, end: 22 })
  })

  it('falls back to the second title when the first is unusable', () => {
    expect(combineSamples({ ...base, title: null }, { ...base, title: 'B' })!.title).toBe('B')
  })

  it('is null when either sample failed to parse', () => {
    expect(combineSamples(null, base)).toBeNull()
    expect(combineSamples(base, null)).toBeNull()
  })
})

describe('titles and scores', () => {
  it('cleans titles', () => {
    expect(cleanTitle('  "Unbelievable clutch" #gaming ')).toBe('Unbelievable clutch')
    expect(cleanTitle('a'.repeat(80))!.length).toBe(60)
    expect(cleanTitle('""')).toBeNull()
  })
  it('blends signal and rating', () => {
    expect(combinedScore(0.5, null)).toBe(0.5)
    expect(combinedScore(0.5, 10)).toBeCloseTo(0.725)
  })
})

describe('ratingFactor', () => {
  it('leaves strength unchanged with no model', () => {
    expect(ratingFactor(null)).toBe(1)
  })
  it('boosts a highly-rated candidate and shrinks a poorly-rated one', () => {
    expect(ratingFactor(10)).toBeGreaterThan(1)
    expect(ratingFactor(9)).toBeGreaterThan(1)
    expect(ratingFactor(1)).toBeLessThan(1)
    expect(ratingFactor(3)).toBeLessThan(1)
  })
  it('is neutral around a middling rating', () => {
    expect(ratingFactor(5)).toBeGreaterThan(0.85)
    expect(ratingFactor(5)).toBeLessThan(1.15)
    expect(ratingFactor(6)).toBeGreaterThan(0.85)
    expect(ratingFactor(6)).toBeLessThan(1.15)
  })
  it('clamps so one extreme rating cannot erase or overpower a candidate', () => {
    expect(ratingFactor(1)).toBeGreaterThan(0)
    expect(ratingFactor(10)).toBeLessThan(3)
  })
})

describe('transcript scan', () => {
  const talk = Array.from({ length: 2000 }, (_, i) => ({ t0: i * 0.5, t1: i * 0.5 + 0.4, text: `w${i}` }))
  it('picks talky windows away from known moments and muted parts', () => {
    const w = scanWindows(1000, talk, [{ start: 200, end: 230 }], 180, 60)
    expect(w[0]).toEqual({ start: 0, end: 180 })
    expect(w.some((r) => r.start === 180)).toBe(false)
    expect(w.every((r) => r.end <= 1000)).toBe(true)
  })
  it('skips quiet stretches', () => {
    expect(scanWindows(1000, talk.slice(0, 50), [], 180, 60)).toEqual([])
  })
  it('asks for a strict rating and JSON', () => {
    const p = buildScanPrompt({ title: 't', channel: 'c', chapter: null }, { offset: 0, range: { start: 0, end: 180 }, lines: ['[0.0] hi'] })
    expect(p).toContain('[0.0] hi')
    expect(p).toContain('Be strict')
    expect(p).toContain('JSON')
  })
})
