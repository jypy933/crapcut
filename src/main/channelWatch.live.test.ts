// Opt-in integration check against the real, pinned yt-dlp and a real
// channel. Off by default: `npm test` never touches the network on its own.
// To run it: CHANNEL_WATCH_LIVE=<channel> npm test -- channelWatch.live

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseChannelVideos } from './core/channelVideos'
import { fetchChannelVideos } from './pipeline/ytdlp'
import { artifact } from './tools/manifest'

const channel = process.env.CHANNEL_WATCH_LIVE

/** Where the pinned yt-dlp lands on a normal install; read-only, no setup. */
function pinnedYtdlpPath(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const a = artifact('yt-dlp')
  return join(local, 'CrapCut', 'tools', a.id, a.version, a.entry)
}

describe.skipIf(!channel)('channel watch against the real pinned yt-dlp', () => {
  it(`lists at least one VOD id for ${channel}`, async () => {
    const ytdlp = pinnedYtdlpPath()
    expect(existsSync(ytdlp)).toBe(true)
    const json = await fetchChannelVideos(ytdlp, channel!, new AbortController().signal, 5)
    const vods = parseChannelVideos(json)
    expect(vods.length).toBeGreaterThan(0)
    expect(vods[0]!.id).toMatch(/^\d+$/)
  }, 30_000)
})
