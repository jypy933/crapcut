import { describe, expect, it } from 'vitest'
import { captionAt, groupWords, isKeywordWord, MIN_HIGHLIGHT_SEC } from './captions'

describe('isKeywordWord', () => {
  it('flags shouted, all-caps words', () => {
    expect(isKeywordWord('STOP')).toBe(true)
    expect(isKeywordWord('OK')).toBe(true)
  })
  it('flags numbers', () => {
    expect(isKeywordWord('100')).toBe(true)
    expect(isKeywordWord('2nd')).toBe(true)
  })
  it('flags exclaimed words', () => {
    expect(isKeywordWord('really!')).toBe(true)
  })
  it('ignores ordinary lowercase and mixed-case words', () => {
    expect(isKeywordWord('watch')).toBe(false)
    expect(isKeywordWord("I'm")).toBe(false)
    expect(isKeywordWord('Chat')).toBe(false)
  })
  it('ignores empty or single-letter text', () => {
    expect(isKeywordWord('')).toBe(false)
    expect(isKeywordWord('  ')).toBe(false)
    expect(isKeywordWord('I')).toBe(false)
    expect(isKeywordWord('!')).toBe(false)
  })
})

describe('groupWords', () => {
  const w = (t0: number, t1: number, text: string) => ({ t0, t1, text })

  it('leaves normally spaced words alone', () => {
    const words = [w(1, 1.3, 'one'), w(1.3, 1.6, 'two'), w(1.6, 1.9, 'three')]
    const [g] = groupWords(words)
    expect(g!.words.map((x) => x.t0)).toEqual([1, 1.3, 1.6])
    expect(g!.start).toBe(1)
  })

  it('starts a new group at a word marked as one, however close it is', () => {
    const groups = groupWords([w(1, 1.3, 'one'), w(1.35, 1.6, 'two'), { ...w(1.65, 1.9, 'three'), newGroup: true }, w(1.95, 2.2, 'four')])
    expect(groups.map((g) => g.words.map((x) => x.text))).toEqual([['one', 'two'], ['three', 'four']])
  })

  it('gives words stamped at the same instant a moment each', () => {
    const groups = groupWords([w(5, 5, 'why'), w(5, 5, 'is'), w(5, 5.3, 'it'), w(5.02, 5.4, 'always'), w(5.4, 5.8, 'late')])
    const starts = groups.flatMap((g) => g.words.map((x) => x.t0))
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(MIN_HIGHLIGHT_SEC - 1e-9)
    // Every word gets its own highlighted moment on screen.
    for (const [i, t] of starts.entries()) {
      const at = captionAt(groups, t + 0.001)
      expect(at?.group.words[at.active]?.text).toBe(['why', 'is', 'it', 'always', 'late'][i])
    }
  })

  it('never starts a group before the previous one has shown its last word', () => {
    const groups = groupWords([w(2, 2, 'a'), w(2, 2, 'b'), w(2, 2, 'c'), w(2.05, 2.3, 'd')])
    expect(groups).toHaveLength(2)
    const last = groups[0]!.words[2]!
    expect(groups[0]!.end).toBeGreaterThan(last.t0)
    expect(groups[1]!.start).toBeGreaterThanOrEqual(last.t0 + MIN_HIGHLIGHT_SEC - 1e-9)
  })
})
