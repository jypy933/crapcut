import { describe, expect, it } from 'vitest'
import type { Range, Word } from '@shared/types'
import { assessSpeech, DEFAULT_QUALITY_OPTIONS, findBadTranscriptRanges, judgeSpeech } from './transcriptQuality'

/** A run of words `step` seconds apart, each lasting `dur` seconds, starting at `t`. */
function phrase(t: number, texts: string[], step = 0.4, dur = 0.3): Word[] {
  return texts.map((text, i) => ({ t0: t + i * step, t1: t + i * step + dur, text }))
}

function ordinarySpeech(t: number, wordCount: number): Word[] {
  const texts: string[] = []
  for (let i = 0; i < wordCount; i++) texts.push(`word${i}${i % 9 === 8 || i === wordCount - 1 ? '.' : ''}`)
  return phrase(t, texts)
}

describe('findBadTranscriptRanges', () => {
  it('finds nothing in ordinary varied speech', () => {
    expect(findBadTranscriptRanges(ordinarySpeech(0, 60))).toEqual([])
  })

  it('does not flag natural repetition ("no no no no") sitting inside real speech', () => {
    const words = [...ordinarySpeech(0, 20), ...phrase(20, ['no', 'no', 'no', 'no']), ...ordinarySpeech(22, 20)]
    expect(findBadTranscriptRanges(words)).toEqual([])
  })

  it('flags a hallucinated phrase loop (real benchmark shape: "I\'m in the middle of it.")', () => {
    const loop = ["i'm", 'in', 'the', 'middle', 'of', 'it.']
    const words = phrase(100, [...loop, ...loop, ...loop, ...loop, ...loop])
    const bad = findBadTranscriptRanges(words)
    expect(bad).toHaveLength(1)
    expect(bad[0]!.start).toBeCloseTo(100, 5)
    expect(bad[0]!.reason).toContain('looped text')
  })

  it('flags a known whisper filler line even without repetition (subtitle credits)', () => {
    const credit = phrase(200, ['Sous-titres', 'réalisés', 'par', 'la', 'communauté', "d'Amara.org."])
    const words = [...ordinarySpeech(0, 30), ...credit, ...ordinarySpeech(300, 30)]
    const bad = findBadTranscriptRanges(words)
    const span = bad.find((b) => b.start >= 199 && b.end <= 203)
    expect(span).toBeDefined()
    expect(span!.reason).toContain('known filler line')
  })

  it('flags repeated "Thank you." hallucinated over silence', () => {
    const words = phrase(0, ['Thank', 'you.', 'Thank', 'you.', 'Thank', 'you.', 'Thank', 'you.', 'Thank', 'you.'])
    const bad = findBadTranscriptRanges(words)
    expect(bad.length).toBeGreaterThan(0)
    expect(bad[0]!.start).toBeCloseTo(0, 5)
  })

  it('flags a low-diversity rambling window that never repeats the same short phrase', () => {
    // A 6-word vocabulary tiled with an 8-word period, so no 1..6-gram repeats
    // back to back, but only 6 distinct words appear across the window.
    const cycle = ['um', 'like', 'you', 'know', 'it', 'was', 'um', 'like']
    const words = phrase(500, [...cycle, ...cycle, ...cycle])
    const bad = findBadTranscriptRanges(words)
    expect(bad.some((b) => b.reason.includes('low lexical diversity'))).toBe(true)
  })

  it('flags many words crammed into near-zero duration in a row', () => {
    const crammed: Word[] = ['then', "he'll", 'sit', 'down', 'for', 'a', 'sec.'].map((text, i) => ({
      t0: 50 + i * 0.001,
      t1: 50 + i * 0.001,
      text
    }))
    const words = [...ordinarySpeech(0, 20), ...crammed, ...ordinarySpeech(60, 20)]
    const bad = findBadTranscriptRanges(words)
    expect(bad.some((b) => b.reason.includes('crammed word timings'))).toBe(true)
  })

  it('flags a single word implausibly stretched over many seconds', () => {
    const words = [...ordinarySpeech(0, 10), { t0: 20, t1: 32, text: 'stretched' }, ...ordinarySpeech(40, 10)]
    const bad = findBadTranscriptRanges(words)
    expect(bad.some((b) => b.reason.includes('implausibly long word'))).toBe(true)
  })
})

describe('assessSpeech and judgeSpeech', () => {
  const window: Range = { start: 0, end: 30 }

  it('is fine when there is no bad transcript in the window', () => {
    const words = ordinarySpeech(0, 60)
    const assessment = assessSpeech(window, words, [])
    expect(assessment.noSpeech).toBe(false)
    expect(judgeSpeech(assessment, 0, 0)).toBe('ok')
  })

  it('drops a mostly-hallucinated window when chat and loudness are weak', () => {
    const loop = ['i', 'need', 'to', 'learn', 'some', 'thoughts.']
    const words = phrase(0, [...loop, ...loop, ...loop, ...loop, ...loop])
    const badRanges = findBadTranscriptRanges(words)
    const assessment = assessSpeech(window, words, badRanges)
    expect(assessment.noSpeech).toBe(true)
    expect(judgeSpeech(assessment, 1, 1)).toBe('drop')
  })

  it('keeps a mostly-hallucinated window (marked) when chat reacted strongly', () => {
    const loop = ['i', 'need', 'to', 'learn', 'some', 'thoughts.']
    const words = phrase(0, [...loop, ...loop, ...loop, ...loop, ...loop])
    const badRanges = findBadTranscriptRanges(words)
    const assessment = assessSpeech(window, words, badRanges)
    expect(judgeSpeech(assessment, DEFAULT_QUALITY_OPTIONS.strongChatZ, 0)).toBe('keep_no_speech')
  })

  it('keeps a mostly-hallucinated window (marked) when it was very loud', () => {
    const loop = ['i', 'need', 'to', 'learn', 'some', 'thoughts.']
    const words = phrase(0, [...loop, ...loop, ...loop, ...loop, ...loop])
    const badRanges = findBadTranscriptRanges(words)
    const assessment = assessSpeech(window, words, badRanges)
    expect(judgeSpeech(assessment, 0, DEFAULT_QUALITY_OPTIONS.strongAudioZ)).toBe('keep_no_speech')
  })

  it('treats a window with essentially no words as no speech even without a flagged range', () => {
    const words: Word[] = [{ t0: 5, t1: 5.3, text: 'hi' }]
    const assessment = assessSpeech(window, words, [])
    expect(assessment.noSpeech).toBe(true)
    expect(judgeSpeech(assessment, 0, 0)).toBe('drop')
  })
})
