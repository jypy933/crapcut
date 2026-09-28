import { describe, expect, it } from 'vitest'
import { compareVodId, newestVodId, parseChannelVideos, selectNewVods, withoutNewest } from './channelVideos'

function playlist(entries: unknown[]): string {
  return JSON.stringify({ _type: 'playlist', entries })
}

// What the pinned yt-dlp actually returns for `--flat-playlist -J` on a
// channel's archives (captured against a real channel): only id and
// duration, id prefixed with "v".
const REAL_ENTRIES = [
  { _type: 'url_transparent', ie_key: 'TwitchVod', id: 'v2885598325', url: 'https://www.twitch.tv/videos/2885598325', title: 'Newest', duration: 22730.0, view_count: 448485 },
  { _type: 'url_transparent', ie_key: 'TwitchVod', id: 'v2884603223', url: 'https://www.twitch.tv/videos/2884603223', title: 'Middle', duration: 38623.0, view_count: 631055 },
  { _type: 'url_transparent', ie_key: 'TwitchVod', id: 'v2883949120', url: 'https://www.twitch.tv/videos/2883949120', title: 'Oldest', duration: 590.0, view_count: 25361 }
]

describe('parseChannelVideos', () => {
  it('reads real flat-playlist entries: id with a "v" prefix and duration only', () => {
    expect(parseChannelVideos(playlist(REAL_ENTRIES))).toEqual([
      { id: '2885598325', title: 'Newest', durationSec: 22730, publishedAt: null, isLive: false },
      { id: '2884603223', title: 'Middle', durationSec: 38623, publishedAt: null, isLive: false },
      { id: '2883949120', title: 'Oldest', durationSec: 590, publishedAt: null, isLive: false }
    ])
  })

  // Kept in case a future yt-dlp version reports these on the listing itself.
  it('reads timestamp and live state when a listing happens to include them', () => {
    const json = playlist([
      { id: 'v111', title: 'First stream', timestamp: 1_700_000_000, duration: 100 },
      { id: '222', title: 'Second stream', release_timestamp: 1_700_100_000, is_live: false },
      { id: 'v333', title: 'Live now', live_status: 'is_live', duration: 60 }
    ])
    expect(parseChannelVideos(json)).toEqual([
      { id: '111', title: 'First stream', durationSec: 100, publishedAt: 1_700_000_000_000, isLive: false },
      { id: '222', title: 'Second stream', durationSec: null, publishedAt: 1_700_100_000_000, isLive: false },
      { id: '333', title: 'Live now', durationSec: 60, publishedAt: null, isLive: true }
    ])
  })

  it('falls back to upload_date when there is no timestamp', () => {
    const json = playlist([{ id: 'v444', title: 'Old one', upload_date: '20240115' }])
    expect(parseChannelVideos(json)[0]?.publishedAt).toBe(Date.UTC(2024, 0, 15))
  })

  it('skips entries without a usable id', () => {
    const json = playlist([{ title: 'No id' }, { id: 'not-a-number', title: 'Bad id' }, { id: 'v666', title: 'Good' }])
    expect(parseChannelVideos(json).map((v) => v.id)).toEqual(['666'])
  })

  it('returns an empty list for junk or missing input', () => {
    expect(parseChannelVideos('not json')).toEqual([])
    expect(parseChannelVideos('{}')).toEqual([])
    expect(parseChannelVideos('[]')).toEqual([])
  })
})

describe('compareVodId', () => {
  it('compares as numbers, not strings', () => {
    expect(compareVodId('9', '10')).toBeLessThan(0)
    expect(compareVodId('2885598325', '2884603223')).toBeGreaterThan(0)
    expect(compareVodId('5', '5')).toBe(0)
  })
})

describe('newestVodId', () => {
  it('finds the greatest id regardless of list order', () => {
    const vods = parseChannelVideos(playlist(REAL_ENTRIES)).reverse()
    expect(newestVodId(vods)).toBe('2885598325')
  })

  it('is null for an empty list', () => {
    expect(newestVodId([])).toBeNull()
  })
})

describe('selectNewVods', () => {
  const vods = parseChannelVideos(playlist(REAL_ENTRIES))

  it('returns nothing until a baseline exists (never back-fill)', () => {
    expect(selectNewVods(vods, null, () => false)).toEqual([])
  })

  it('keeps only VODs with a strictly greater id than the baseline', () => {
    const picked = selectNewVods(vods, '2883949120', () => false)
    expect(picked.map((v) => v.id)).toEqual(['2884603223', '2885598325'])
  })

  it('excludes the baseline id itself', () => {
    expect(selectNewVods(vods, '2885598325', () => false)).toEqual([])
  })

  it('skips a VOD that already has a job', () => {
    const picked = selectNewVods(vods, '2883949120', (id) => id === '2884603223')
    expect(picked.map((v) => v.id)).toEqual(['2885598325'])
  })

  it('orders oldest first regardless of input order', () => {
    const shuffled = [vods[0]!, vods[2]!, vods[1]!]
    expect(selectNewVods(shuffled, '0', () => false).map((v) => v.id)).toEqual(['2883949120', '2884603223', '2885598325'])
  })

  it('never treats an entry flagged live as new', () => {
    const withLive = [...vods, { id: '2885598326', title: 'Live', durationSec: 10, publishedAt: null, isLive: true }]
    expect(selectNewVods(withLive, '2883949120', () => false).some((v) => v.id === '2885598326')).toBe(false)
  })
})

describe('withoutNewest', () => {
  it('drops only the greatest id', () => {
    const vods = parseChannelVideos(playlist(REAL_ENTRIES))
    expect(withoutNewest(vods).map((v) => v.id)).toEqual(['2884603223', '2883949120'])
  })

  it('is a no-op on an empty list', () => {
    expect(withoutNewest([])).toEqual([])
  })
})
