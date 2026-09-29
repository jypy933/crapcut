import { describe, expect, it } from 'vitest'
import { editGroupText, toVodTime } from './captionEdit'
import { clipWords, groupWords } from './captions'
import { repairWordTimings } from './wordTiming'
import type { Word } from './types'

const words = [
  { t0: 10, t1: 10.3, text: 'hello' },
  { t0: 10.3, t1: 10.6, text: 'there' },
  { t0: 10.6, t1: 11, text: 'mate.' },
  { t0: 12, t1: 12.4, text: 'next' }
]

describe('editGroupText', () => {
  const group = groupWords(words)[0]!

  it('keeps timings when the word count matches', () => {
    expect(editGroupText(words, group, 'Hello there, mate!')).toEqual([
      { t0: 10, t1: 10.3, text: 'Hello' },
      { t0: 10.3, t1: 10.6, text: 'there,' },
      { t0: 10.6, t1: 11, text: 'mate!' },
      { t0: 12, t1: 12.4, text: 'next' }
    ])
  })

  it('spreads new words evenly when the count changes', () => {
    const r = editGroupText(words, group, 'hi mate')
    expect(r.slice(0, 2)).toEqual([
      { t0: 10, t1: 10.5, text: 'hi' },
      { t0: 10.5, t1: 11, text: 'mate' }
    ])
    expect(r[2]!.text).toBe('next')
  })

  it('removes the group when emptied', () => {
    expect(editGroupText(words, group, '   ').map((w) => w.text)).toEqual(['next'])
  })

  it('does nothing (and never duplicates) when no matching run of words is found', () => {
    const strayGroup = groupWords([{ t0: 999, t1: 999.3, text: 'ghost' }])[0]!
    expect(editGroupText(words, strayGroup, 'boo')).toEqual(words)
  })
})

// These reproduce a real bug: the Review screen builds its on-screen groups
// from `groupWords(clipWords(clip.words, clip.start, clip.end))`, then shifts
// a group's clip-relative timings back by `clip.start` to look the edited
// words up in `clip.words` (VOD time). `clipWords` clamps a word that
// straddles the clip's start or end to the clip's own [0, duration) range for
// display, so that round trip does not always land back on the original
// timestamp. The old matching (exact `t0` + text per word) then failed to
// recognise the group's own words as "in the group", so an edit added the new
// words without removing the old ones - each edit of the same row left more
// duplicate rows/words behind, and their near-zero clip-relative time is why
// they all showed "0.0 s".
describe('editGroupText matches by word text, not exact clamped timings', () => {
  function reviewGroups(clipWordsVod: Word[], clipStart: number, clipEnd: number) {
    const repaired = repairWordTimings(clipWordsVod)
    return { repaired, groups: groupWords(clipWords(repaired, clipStart, clipEnd)) }
  }

  it('replaces (never duplicates) the first word of a clip that straddles the clip start', () => {
    // "Tired" starts just before clip.start: clipWords clamps its displayed
    // clip-relative t0 to 0, so shifting that back by +clipStart gives 100,
    // not the true 99.9.
    const clipStart = 100
    const clipEnd = 106
    const clipWordsVod: Word[] = [
      { t0: 99.9, t1: 100.3, text: 'Tired' },
      { t0: 100.3, t1: 100.6, text: 'of' },
      { t0: 100.6, t1: 101.0, text: 'mud?' },
      { t0: 103, t1: 103.4, text: 'next' }
    ]
    const { repaired, groups } = reviewGroups(clipWordsVod, clipStart, clipEnd)
    const result = editGroupText(repaired, groups[0]!, 'Tired', clipStart)
    expect(result.map((w) => w.text)).toEqual(['Tired', 'next'])
  })

  it('stays clean across several edits of the same row, including word-count changes', () => {
    const clipStart = 100
    const clipEnd = 106
    let clipWordsVod: Word[] = [
      { t0: 98, t1: 98.4, text: 'before' },
      { t0: 100.1, t1: 100.5, text: 'Tired' },
      { t0: 100.5, t1: 100.8, text: 'of' },
      { t0: 100.8, t1: 101.2, text: 'mud?' },
      { t0: 103, t1: 103.4, text: 'next' }
    ]
    for (const text of ['Tired', 'Tired of mud', 'Tired of mud again']) {
      const { repaired, groups } = reviewGroups(clipWordsVod, clipStart, clipEnd)
      clipWordsVod = editGroupText(repaired, groups[0]!, text, clipStart)
    }
    expect(clipWordsVod.map((w) => w.text)).toEqual(['before', 'Tired', 'of', 'mud', 'again', 'next'])
  })
})

describe('toVodTime', () => {
  it('adds the clip start', () => {
    expect(toVodTime([{ t0: 1, t1: 2, text: 'a' }], 100)).toEqual([{ t0: 101, t1: 102, text: 'a' }])
  })
})
