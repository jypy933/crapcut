import { describe, expect, it } from 'vitest'
import { parseTwitchTime, parseVodUrl } from './vodUrl'

describe('parseVodUrl', () => {
  it.each([
    'https://www.twitch.tv/videos/2245012345',
    'http://twitch.tv/videos/2245012345',
    'twitch.tv/videos/2245012345',
    'www.twitch.tv/videos/2245012345/',
    'https://m.twitch.tv/videos/2245012345',
    '  https://www.twitch.tv/videos/2245012345?filter=archives&sort=time  ',
    'HTTPS://WWW.TWITCH.TV/videos/2245012345'
  ])('accepts %s', (input) => {
    const r = parseVodUrl(input)
    expect(r).toMatchObject({ ok: true, id: '2245012345', url: 'https://www.twitch.tv/videos/2245012345' })
  })

  it('reads the start time', () => {
    expect(parseVodUrl('https://www.twitch.tv/videos/1?t=1h2m3s')).toMatchObject({ ok: true, startAtSec: 3723 })
  })

  it.each([
    '',
    'hello',
    'https://www.twitch.tv/somechannel',
    'https://www.twitch.tv/somechannel/clip/FunnyClipSlug',
    'https://clips.twitch.tv/FunnyClipSlug',
    'https://www.twitch.tv/videos/abc',
    'https://www.twitch.tv/videos/123/extra',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://evil.com/twitch.tv/videos/123',
    'https://twitch.tv.evil.com/videos/123',
    'https://user:pass@www.twitch.tv/videos/123',
    'https://www.twitch.tv:8443/videos/123',
    'ftp://www.twitch.tv/videos/123',
    'file:///C:/videos/123',
    'javascript:alert(1)',
    `https://www.twitch.tv/videos/1?x=${'a'.repeat(400)}`
  ])('rejects %s', (input) => {
    const r = parseVodUrl(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0)
  })
})

describe('parseTwitchTime', () => {
  it('parses h/m/s', () => {
    expect(parseTwitchTime('90s')).toBe(90)
    expect(parseTwitchTime('2m')).toBe(120)
    expect(parseTwitchTime('1h0m5s')).toBe(3605)
  })
  it('rejects junk', () => {
    expect(parseTwitchTime('')).toBeNull()
    expect(parseTwitchTime('abc')).toBeNull()
    expect(parseTwitchTime(null)).toBeNull()
  })
})
