import { describe, expect, it } from 'vitest'
import { editGroupText, toVodTime } from './captionEdit'
import { groupWords } from './captions'

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
})

describe('toVodTime', () => {
  it('adds the clip start', () => {
    expect(toVodTime([{ t0: 1, t1: 2, text: 'a' }], 100)).toEqual([{ t0: 101, t1: 102, text: 'a' }])
  })
})
