import { describe, expect, it } from 'vitest'
import type { Word } from './types'
import { collapseLoops, DEFAULT_LOOP_OPTIONS, findLoopRuns, normaliseWord } from './transcriptLoops'

/** A run of words half a second apart starting at `t`. */
function phrase(t: number, texts: string[], step = 0.4): Word[] {
  return texts.map((text, i) => ({ t0: t + i * step, t1: t + i * step + step * 0.75, text }))
}

function words(...groups: Word[][]): Word[] {
  return groups.flat()
}

describe('normaliseWord', () => {
  it('lowercases and drops punctuation', () => {
    expect(normaliseWord('It.')).toBe('it')
    expect(normaliseWord("I'm")).toBe('im')
    expect(normaliseWord('WOW!')).toBe('wow')
  })
})

describe('findLoopRuns', () => {
  it('finds nothing in ordinary speech', () => {
    const w = phrase(0, ['this', 'guy', 'is', 'actually', 'insane', 'right', 'now'])
    expect(findLoopRuns(w)).toEqual([])
  })

  it('allows short natural repetition ("no no no no")', () => {
    const w = phrase(0, ['no', 'no', 'no', 'no'])
    expect(findLoopRuns(w)).toEqual([])
  })

  it('allows "go go go" as hype, not a loop', () => {
    const w = phrase(0, ['go', 'go', 'go'])
    expect(findLoopRuns(w)).toEqual([])
  })

  it('flags a single word repeated past the natural limit', () => {
    const w = phrase(0, ['of', 'of', 'of', 'of', 'of', 'of', 'of'])
    const runs = findLoopRuns(w)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ start: 0, end: 7, gram: 1, repeats: 7 })
  })

  it('flags a short phrase looping (whisper "thank you" hallucination)', () => {
    const w = phrase(0, ['thank', "you.", 'thank', "you.", 'thank', "you.", 'thank', "you.", 'thank', "you."])
    const runs = findLoopRuns(w)
    expect(runs.some((r) => r.gram === 2 && r.repeats === 5)).toBe(true)
  })

  it('flags a real hallucination loop seen in a benchmark ("I\'m in the middle of it.")', () => {
    // Reduced from a real whisper.cpp loop over background game noise.
    const loop = ["i'm", 'in', 'the', 'middle', 'of', 'it.']
    const w = phrase(
      0,
      [...loop, ...loop, ...loop, ...loop, ...loop, 'motherfuck,', 'different', 'words', 'now.']
    )
    const runs = findLoopRuns(w)
    const sixGram = runs.find((r) => r.gram === 6)
    expect(sixGram).toBeDefined()
    expect(sixGram!.repeats).toBe(5)
    expect(sixGram!.start).toBe(0)
    expect(sixGram!.end).toBe(30)
  })

  it('does not flag a phrase repeated only within the natural limit', () => {
    const loop = ['i', 'need', 'to', 'calm', 'down.']
    const w = phrase(0, [...loop, ...loop, ...loop])
    expect(findLoopRuns(w)).toEqual([])
  })
})

describe('collapseLoops', () => {
  it('leaves ordinary speech untouched', () => {
    const w = phrase(0, ['this', 'guy', 'is', 'insane'])
    expect(collapseLoops(w)).toEqual(w)
  })

  it('keeps natural repetition ("no no no no") intact', () => {
    const w = phrase(0, ['no', 'no', 'no', 'no'])
    expect(collapseLoops(w)).toEqual(w)
  })

  it('collapses a looping word down to one occurrence, dropping the rest with their timings', () => {
    const w = phrase(0, ['of', 'of', 'of', 'of', 'of', 'of'])
    const collapsed = collapseLoops(w)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]).toEqual(w[0])
  })

  it('collapses a looping phrase to its first occurrence and keeps real speech after it', () => {
    const loop = ["i'm", 'in', 'the', 'middle', 'of', 'it.']
    const tail = ['motherfuck,', 'different', 'words', 'now.']
    const w = words(phrase(0, [...loop, ...loop, ...loop, ...loop, ...loop, ...tail]))
    const collapsed = collapseLoops(w)
    expect(collapsed.map((x) => x.text)).toEqual([...loop, ...tail])
    // The kept occurrence has its own real timing, not shifted.
    expect(collapsed[0]).toEqual(w[0])
    expect(collapsed[5]).toEqual(w[5])
  })

  it('is idempotent', () => {
    const loop = ['tired', 'tired', 'tired', 'tired', 'tired', 'tired']
    const w = phrase(0, loop)
    const once = collapseLoops(w)
    const twice = collapseLoops(once)
    expect(twice).toEqual(once)
  })

  it('respects a custom natural-repeat limit', () => {
    const w = phrase(0, ['no', 'no', 'no', 'no', 'no'])
    expect(collapseLoops(w, { ...DEFAULT_LOOP_OPTIONS, maxNaturalRepeats: 6 })).toEqual(w)
  })
})
