import { describe, expect, it } from 'vitest'
import type { Word } from '@shared/types'
import { clipCaptionRange, resolveClipCaptionWords, shouldSkipClipCaptions } from './clipCaptions'
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
