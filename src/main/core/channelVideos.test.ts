import { describe, expect, it } from 'vitest'
import { parseChannelVideos, selectNewVods } from './channelVideos'

function playlist(entries: unknown[]): string {
  return JSON.stringify({ _type: 'playlist', entries })
}

describe('parseChannelVideos', () => {
  it('reads id, title, timestamp and live state', () => {
    const json = playlist([
      { id: '111', title: 'First stream', timestamp: 1_700_000_000 },
      { id: '222', title: 'Second stream', release_timestamp: 1_700_100_000, is_live: false },
      { id: '333', title: 'Live now', live_status: 'is_live' }
    ])
    expect(parseChannelVideos(json)).toEqual([
      { id: '111', title: 'First stream', publishedAt: 1_700_000_000_000, isLive: false },
      { id: '222', title: 'Second stream', publishedAt: 1_700_100_000_000, isLive: false },
      { id: '333', title: 'Live now', publishedAt: null, isLive: true }
    ])
  })

  it('falls back to upload_date when there is no timestamp', () => {
    const json = playlist([{ id: '444', title: 'Old one', upload_date: '20240115' }])
    expect(parseChannelVideos(json)).toEqual([{ id: '444', title: 'Old one', publishedAt: Date.UTC(2024, 0, 15), isLive: false }])
  })

  it('leaves publishedAt null when nothing usable is present', () => {
    const json = playlist([{ id: '555', title: 'Mystery' }])
    expect(parseChannelVideos(json)[0]?.publishedAt).toBeNull()
  })

  it('skips entries without a numeric id', () => {
    const json = playlist([{ title: 'No id' }, { id: 'not-a-number', title: 'Bad id' }, { id: '666', title: 'Good' }])
    expect(parseChannelVideos(json).map((v) => v.id)).toEqual(['666'])
  })

  it('returns an empty list for junk or missing input', () => {
    expect(parseChannelVideos('not json')).toEqual([])
    expect(parseChannelVideos('{}')).toEqual([])
    expect(parseChannelVideos('[]')).toEqual([])
  })
})

describe('selectNewVods', () => {
  const vods = [
    { id: '1', title: 'Before the watch', publishedAt: 1000, isLive: false },
    { id: '2', title: 'Right after', publishedAt: 2000, isLive: false },
    { id: '3', title: 'Later still', publishedAt: 3000, isLive: false },
    { id: '4', title: 'Still live', publishedAt: 4000, isLive: true },
    { id: '5', title: 'Unknown time', publishedAt: null, isLive: false }
  ]

  it('keeps only VODs published after the watch started', () => {
    const picked = selectNewVods(vods, 1500, () => false)
    expect(picked.map((v) => v.id)).toEqual(['2', '3'])
  })

  it('never includes a VOD published at or before the watch started (no back-fill)', () => {
    expect(selectNewVods(vods, 1000, () => false).some((v) => v.id === '1')).toBe(false)
  })

  it('skips VODs that are still live', () => {
    expect(selectNewVods(vods, 100, () => false).some((v) => v.id === '4')).toBe(false)
  })

  it('skips VODs with an unknown publish time rather than guessing', () => {
    expect(selectNewVods(vods, 100, () => false).some((v) => v.id === '5')).toBe(false)
  })

  it('skips a VOD that already has a job', () => {
    const picked = selectNewVods(vods, 1500, (id) => id === '2')
    expect(picked.map((v) => v.id)).toEqual(['3'])
  })

  it('orders oldest first', () => {
    const reordered = [vods[2]!, vods[1]!]
    expect(selectNewVods(reordered, 1500, () => false).map((v) => v.id)).toEqual(['2', '3'])
  })
})
