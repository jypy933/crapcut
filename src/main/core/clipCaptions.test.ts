import { describe, expect, it } from 'vitest'
import type { Word } from '@shared/types'
import { clipCaptionRange, fastChunkRanges, overlapsAnyRange, resolveClipCaptionWords, shouldSkipClipCaptions } from './clipCaptions'
import { placeChunkWords } from './transcript'

function w(t0: number, t1: number, text: string): Word {
  return { t0, t1, text }
}

describe('clipCaptionRange', () => {
  it('pads both sides of the clip', () => {
    expect(clipCaptionRange({ start: 100, end: 130 }, 10_000, 20)).toEqual({ start: 80, end: 150 })
  })

  it('clamps to the start of the VOD', () => {
    expect(clipCaptionRange({ start: 5, end: 30 }, 10_000, 20)).toEqual({ start: 0, end: 50 })
  })

  it('clamps to the end of the VOD', () => {
    expect(clipCaptionRange({ start: 9970, end: 9990 }, 10_000, 20)).toEqual({ start: 9950, end: 10_000 })
  })

  it('handles a clip that is itself shorter than the padding', () => {
    expect(clipCaptionRange({ start: 40, end: 42 }, 10_000, 20)).toEqual({ start: 20, end: 62 })
  })
})

describe('shouldSkipClipCaptions', () => {
  it('skips a clip whose captions were hand-edited', () => {
    expect(shouldSkipClipCaptions({ wordsEdited: true })).toBe(true)
  })

  it('does not skip an untouched clip, including old rows missing the field', () => {
    expect(shouldSkipClipCaptions({ wordsEdited: false })).toBe(false)
    expect(shouldSkipClipCaptions({ wordsEdited: undefined })).toBe(false)
    expect(shouldSkipClipCaptions({})).toBe(false)
  })
})

describe('resolveClipCaptionWords', () => {
  const fastPass = [w(0, 1, 'hello'), w(1, 2, 'world')]

  it('keeps the re-transcribed words when there are some', () => {
    const fresh = [w(0.1, 0.9, 'hello'), w(1, 2, 'world'), w(2, 2.4, 'again')]
    expect(resolveClipCaptionWords(fastPass, fresh)).toBe(fresh)
  })

  it('falls back to the fast-pass words when the attempt failed', () => {
    expect(resolveClipCaptionWords(fastPass, null)).toBe(fastPass)
  })

  it('falls back to the fast-pass words when the clip landed on silence (no words found)', () => {
    expect(resolveClipCaptionWords(fastPass, [])).toBe(fastPass)
  })
})

describe('re-transcription offsetting (clipCaptionRange + placeChunkWords)', () => {
  it('moves a clip cut wav\'s own-time words back onto the VOD timeline', () => {
    const range = clipCaptionRange({ start: 500, end: 520 }, 10_000, 20)
    expect(range).toEqual({ start: 480, end: 540 })
    // Whisper times these relative to the cut wav it was given (0-based).
    const own = [w(0, 1, 'hi'), w(30, 31, 'there'), w(59, 60, 'bye')]
    const { words, dropped } = placeChunkWords(own, range)
    expect(words.map((x) => [x.t0, x.t1, x.text])).toEqual([
      [480, 481, 'hi'],
      [510, 511, 'there'],
      [539, 540, 'bye']
    ])
    expect(dropped).toBe(0)
  })

  it('drops a word whisper mistakenly timed well outside the cut range', () => {
    const range = { start: 480, end: 540 }
    const own = [w(0, 1, 'hi'), w(1000, 1001, 'nonsense')]
    const { words, dropped } = placeChunkWords(own, range)
    expect(words).toHaveLength(1)
    expect(dropped).toBe(1)
  })
})

describe('fastChunkRanges', () => {
  const a = { start: 0, end: 600 }
  const b = { start: 600, end: 1200 }
  const c = { start: 1200, end: 1500 }

  it('keeps only the chunks that did not run the large model on the GPU', () => {
    expect(fastChunkRanges([{ range: a, sharp: true }, { range: b, sharp: false }, { range: c, sharp: true }])).toEqual([b])
  })

  it('treats a chunk with no record as fast (written before the record existed)', () => {
    expect(fastChunkRanges([{ range: a }, { range: b, sharp: true }])).toEqual([a])
  })

  it('is empty when every chunk was sharp', () => {
    expect(fastChunkRanges([{ range: a, sharp: true }, { range: b, sharp: true }])).toEqual([])
  })
})

describe('overlapsAnyRange', () => {
  const ranges = [{ start: 600, end: 1200 }]

  it('is true when the clip range touches a stretch', () => {
    expect(overlapsAnyRange({ start: 580, end: 640 }, ranges)).toBe(true)
    expect(overlapsAnyRange({ start: 700, end: 800 }, ranges)).toBe(true)
    expect(overlapsAnyRange({ start: 1190, end: 1250 }, ranges)).toBe(true)
  })

  it('is false when the clip range sits fully outside, even edge to edge', () => {
    expect(overlapsAnyRange({ start: 100, end: 600 }, ranges)).toBe(false)
    expect(overlapsAnyRange({ start: 1200, end: 1300 }, ranges)).toBe(false)
  })

  it('is false when there is nothing to overlap', () => {
    expect(overlapsAnyRange({ start: 0, end: 10_000 }, [])).toBe(false)
  })
})
