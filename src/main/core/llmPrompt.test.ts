import { describe, expect, it } from 'vitest'
import type { Candidate } from './moments'
import { buildPrompt, cleanTitle, combinedScore, excerptLines, excerptRange, parseAnswer, topChat, type Excerpt } from './llmPrompt'

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
