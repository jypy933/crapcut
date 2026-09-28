import { describe, expect, it } from 'vitest'
import { parseChannelName } from './channelName'

describe('parseChannelName', () => {
  it.each(['streamer', '  streamer  ', '@streamer', 'twitch.tv/streamer', 'https://www.twitch.tv/streamer', 'www.twitch.tv/streamer?x=1', 'm.twitch.tv/streamer/videos'])('accepts %s', (input) => {
    expect(parseChannelName(input)).toMatchObject({ ok: true, channel: 'streamer' })
  })

  it('lower-cases the channel', () => {
    expect(parseChannelName('StReAmEr')).toMatchObject({ ok: true, channel: 'streamer' })
  })

  it.each(['', '   ', 'ab', 'a'.repeat(26), 'has space', 'has-dash', 'https://www.twitch.tv/', 'https://www.youtube.com/streamer', 'https://www.twitch.tv/videos', '_leading', `x${'y'.repeat(300)}`])(
    'rejects %s',
    (input) => {
      const r = parseChannelName(input)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0)
    }
  )
})
