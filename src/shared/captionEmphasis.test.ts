import { describe, expect, it } from 'vitest'
import { groupWords } from './captions'
import { emphasisScore, MIN_EMPHASIS_GAP_SEC, pickEmphasis } from './captionEmphasis'
import type { Word } from './types'

const w = (t0: number, t1: number, text: string): Word => ({ t0, t1, text })

/** One word every 0.3 s from `start`, grouped the way the captions are. */
function groupsOf(texts: string[], start = 0) {
  return groupWords(texts.map((t, i) => w(start + i * 0.3, start + i * 0.3 + 0.25, t)))
}

describe('emphasisScore', () => {
  it('scores keywords, long words and sentence ends, and never filler', () => {
    expect(emphasisScore('STOP')).toBeGreaterThanOrEqual(3)
    expect(emphasisScore('100')).toBeGreaterThanOrEqual(3)
    expect(emphasisScore('insane.')).toBe(2)
    expect(emphasisScore('watch')).toBe(0)
    expect(emphasisScore('incredible')).toBe(1)
  })
  it('never scores filler or small words, even shouted or punctuated', () => {
    for (const t of ['um', 'UM', 'OK', 'like', 'Yeah!', 'okay.', 'the', 'I', "It's", 'LOL', 'literally!', '']) expect(emphasisScore(t)).toBe(0)
  })
})

describe('pickEmphasis', () => {
  it('picks at most one word per group', () => {
    const groups = groupsOf(['100', 'STOP', 'NOW!'])
    const picks = pickEmphasis(groups)
    expect(picks).toHaveLength(1)
    expect(picks[0]).toBe(2) // the punchline wins the tie
  })
  it('picks nothing from plain, short talk', () => {
    expect(pickEmphasis(groupsOf(['so', 'we', 'go', 'and', 'see'])).every((p) => p === -1)).toBe(true)
  })
  it('picks a long word only when it ends the sentence', () => {
    expect(pickEmphasis(groupsOf(['this', 'is', 'amazing']))).toEqual([-1])
    expect(pickEmphasis(groupsOf(['this', 'is', 'amazing.']))).toEqual([2])
  })
  it('never picks a filler word, even the only shouted one', () => {
    expect(pickEmphasis(groupsOf(['OK', 'um', 'like']))).toEqual([-1])
  })
  it('keeps emphasised words at least the minimum gap apart', () => {
    // A keyword every ~0.9 s, one per group.
    const texts = ['a', 'b', 'c1', 'd', 'e', 'f2', 'g', 'h', 'i3', 'j', 'k', 'l4', 'm', 'n', 'o5']
    const groups = groupsOf(texts)
    const picks = pickEmphasis(groups)
    const times = picks.flatMap((p, g) => (p >= 0 ? [groups[g]!.words[p]!.t0] : []))
    expect(times.length).toBeGreaterThan(1)
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(MIN_EMPHASIS_GAP_SEC)
  })
  it('lets a clearly stronger word replace a close, weaker one', () => {
    const groups = groupWords([w(0, 0.3, 'amazing.'), w(1, 1.3, 'STOP!')])
    expect(groups).toHaveLength(2)
    expect(pickEmphasis(groups)).toEqual([-1, 0])
  })
  it('follows edited words and copes with empty input', () => {
    expect(pickEmphasis([])).toEqual([])
    const before = groupsOf(['we', 'won', 'today'])
    expect(pickEmphasis(before)).toEqual([-1])
    const after = groupsOf(['we', 'won', 'TODAY'])
    expect(pickEmphasis(after)).toEqual([2])
  })
  it('returns one entry per group', () => {
    const groups = groupWords([w(0, 0.3, 'hey.'), w(3, 3.3, '100'), w(6, 6.3, 'what')])
    expect(pickEmphasis(groups)).toHaveLength(groups.length)
  })
})
