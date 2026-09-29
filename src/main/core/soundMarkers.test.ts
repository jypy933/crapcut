import { describe, expect, it } from 'vitest'
import { soundMarkerMask } from './soundMarkers'

const kept = (texts: string[]): string[] => texts.filter((_, i) => !soundMarkerMask(texts)[i])

describe('soundMarkerMask', () => {
  it('drops a description split into one entry per word', () => {
    expect(kept([' Hello', ' *Dramatic', ' music*', ' go'])).toEqual([' Hello', ' go'])
    expect(kept([' (upbeat', ' electronic', ' music)', ' yes'])).toEqual([' yes'])
    expect(kept([' [BLANK', '_', 'AUDIO]'])).toEqual([])
  })

  it('handles a closer followed by punctuation, and sung notes', () => {
    expect(kept([' *Dramatic', ' music*.', ' ok'])).toEqual([' ok'])
    expect(kept([' ♪', ' la', ' la', ' ♪', ' hey'])).toEqual([' hey'])
  })

  it('leaves one-piece markers to the caller and censored words alone', () => {
    expect(soundMarkerMask([' [Music]', ' *sigh*'])).toEqual([false, false])
    expect(kept([' what', ' the', ' f***ing', ' hell'])).toEqual([' what', ' the', ' f***ing', ' hell'])
    expect(kept([' f***', ' you', ' f***'])).toEqual([' f***', ' you', ' f***'])
  })

  it('does not close an opener with a different kind of bracket', () => {
    expect(kept([' (um', ' that', ' is', ' f***'])).toEqual([' (um', ' that', ' is', ' f***'])
  })

  it('leaves an opener with no closer nearby alone', () => {
    const texts = [' *Wait', ...Array.from({ length: 9 }, () => ' word'), ' now*']
    expect(soundMarkerMask(texts).some(Boolean)).toBe(false)
  })
})
