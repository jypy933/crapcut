import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelWatchService } from './channelWatch'
import { Store } from './store'
import type { ToolRegistry } from './tools/registry'
import { UserError } from './util/errors'

let dir = ''
let store: Store
const tools = { path: () => 'C:\\fake\\yt-dlp.exe' } as unknown as ToolRegistry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crapcut-watch-'))
  store = new Store(join(dir, 'db.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

// What the pinned yt-dlp's flat-playlist listing actually returns: id with a
// "v" prefix and duration only, nothing else.
function playlist(ids: string[]): string {
  return JSON.stringify({ entries: ids.map((id) => ({ id: `v${id}`, title: `Stream ${id}`, duration: 100 })) })
}

function service(opts: { fetchVideos?: ReturnType<typeof vi.fn>; fetchIsLive?: ReturnType<typeof vi.fn>; isReady?: () => boolean; enqueueJob?: ReturnType<typeof vi.fn> } = {}): {
  svc: ChannelWatchService
  enqueueJob: ReturnType<typeof vi.fn>
  fetchVideos: ReturnType<typeof vi.fn>
  fetchIsLive: ReturnType<typeof vi.fn>
} {
  const enqueueJob = opts.enqueueJob ?? vi.fn()
  const fetchVideos = opts.fetchVideos ?? vi.fn().mockResolvedValue(playlist([]))
  const fetchIsLive = opts.fetchIsLive ?? vi.fn().mockResolvedValue(false)
  const svc = new ChannelWatchService(
    { store, tools, isReady: opts.isReady ?? (() => true), enqueueJob: enqueueJob as (jobId: string) => void },
    fetchVideos as never,
    fetchIsLive as never
  )
  return { svc, enqueueJob, fetchVideos, fetchIsLive }
}

describe('ChannelWatchService', () => {
  it('has no watch by default', () => {
    const { svc } = service()
    expect(svc.status()).toMatchObject({ channel: null, enabledAt: null })
  })

  it('rejects a bad channel name without touching the store', () => {
    const { svc } = service()
    const r = svc.set('a')
    expect(r).toMatchObject({ ok: false })
    expect(svc.status().channel).toBeNull()
  })

  it('accepts a valid channel and records when it started', () => {
    const { svc } = service()
    const before = Date.now()
    const r = svc.set('streamer')
    expect(r).toMatchObject({ ok: true, channel: 'streamer' })
    const s = svc.status()
    expect(s.channel).toBe('streamer')
    expect(s.enabledAt).toBeGreaterThanOrEqual(before)
  })

  it('clears the watch', () => {
    const { svc } = service()
    svc.set('streamer')
    svc.clear()
    expect(svc.status().channel).toBeNull()
  })

  it('does nothing when no channel is watched', async () => {
    const { svc, fetchVideos } = service()
    await svc.check()
    expect(fetchVideos).not.toHaveBeenCalled()
  })

  it('does nothing while setup is not ready', async () => {
    const { svc, fetchVideos } = service({ isReady: () => false })
    svc.set('streamer')
    await svc.check()
    expect(fetchVideos).not.toHaveBeenCalled()
  })

  it('establishes a baseline on the first check and queues nothing yet (no back-fill)', async () => {
    const fetchVideos = vi.fn().mockResolvedValue(playlist(['100', '99', '98']))
    const { svc, enqueueJob, fetchIsLive } = service({ fetchVideos })
    svc.set('streamer')
    await svc.check()
    expect(enqueueJob).not.toHaveBeenCalled()
    expect(fetchIsLive).not.toHaveBeenCalled()
    // The same listing again should still queue nothing: nothing is newer
    // than the baseline that was just recorded.
    await svc.check()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('waits for a VOD before picking a baseline when the channel has none yet', async () => {
    const fetchVideos = vi.fn().mockResolvedValueOnce(playlist([])).mockResolvedValueOnce(playlist(['100']))
    const { svc, enqueueJob } = service({ fetchVideos })
    svc.set('streamer')
    await svc.check()
    expect(enqueueJob).not.toHaveBeenCalled()
    // First VOD ever seen becomes the baseline, not queued.
    await svc.check()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('queues a VOD with a greater id than the baseline', async () => {
    const fetchVideos = vi.fn().mockResolvedValueOnce(playlist(['100'])).mockResolvedValueOnce(playlist(['101', '100']))
    const { svc, enqueueJob } = service({ fetchVideos, fetchIsLive: vi.fn().mockResolvedValue(false) })
    svc.set('streamer')
    await svc.check() // baseline = 100
    await svc.check() // 101 is new
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    expect(store.findActiveJobForVod('101')).not.toBeNull()
  })

  it('never queues a VOD at or below the baseline', async () => {
    const fetchVideos = vi.fn().mockResolvedValue(playlist(['100', '99']))
    const { svc, enqueueJob } = service({ fetchVideos })
    svc.set('streamer')
    await svc.check() // baseline = 100
    await svc.check() // nothing newer than 100
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('holds back the newest VOD while the channel is live, then queues it once offline', async () => {
    const fetchVideos = vi.fn().mockResolvedValueOnce(playlist(['100'])).mockResolvedValue(playlist(['101', '100']))
    const fetchIsLive = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { svc, enqueueJob } = service({ fetchVideos, fetchIsLive })
    svc.set('streamer')
    await svc.check() // baseline = 100
    await svc.check() // 101 exists but the channel is live: held back
    expect(enqueueJob).not.toHaveBeenCalled()
    await svc.check() // channel offline now: 101 is queued
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    expect(store.findActiveJobForVod('101')).not.toBeNull()
  })

  it('does not check whether the channel is live when there is nothing new', async () => {
    const fetchVideos = vi.fn().mockResolvedValue(playlist(['100']))
    const { svc, fetchIsLive } = service({ fetchVideos })
    svc.set('streamer')
    await svc.check()
    fetchIsLive.mockClear()
    await svc.check()
    expect(fetchIsLive).not.toHaveBeenCalled()
  })

  it('does not queue the same VOD twice across checks', async () => {
    const fetchVideos = vi.fn().mockResolvedValueOnce(playlist(['100'])).mockResolvedValue(playlist(['101', '100']))
    const { svc, enqueueJob } = service({ fetchVideos, fetchIsLive: vi.fn().mockResolvedValue(false) })
    svc.set('streamer')
    await svc.check() // baseline = 100
    await svc.check() // queues 101
    await svc.check() // 101 already has a job
    expect(enqueueJob).toHaveBeenCalledTimes(1)
  })

  it('records one plain sentence when the check fails', async () => {
    const fetchVideos = vi.fn().mockRejectedValue(new UserError('No channel named "streamer" was found.', { retryable: false }))
    const { svc } = service({ fetchVideos })
    svc.set('streamer')
    await svc.check()
    expect(svc.status().lastError).toBe('No channel named "streamer" was found.')
  })

  it('clears a previous error on the next successful check', async () => {
    const fetchVideos = vi.fn().mockRejectedValueOnce(new UserError('Could not reach Twitch. Check your internet connection.')).mockResolvedValueOnce(playlist([]))
    const { svc } = service({ fetchVideos })
    svc.set('streamer')
    await svc.check()
    expect(svc.status().lastError).not.toBeNull()
    await svc.check()
    expect(svc.status().lastError).toBeNull()
  })

  it('ignores an overlapping check', async () => {
    let resolveFirst: (v: string) => void = () => {}
    const fetchVideos = vi
      .fn()
      .mockReturnValueOnce(new Promise<string>((r) => (resolveFirst = r)))
      .mockResolvedValue(playlist([]))
    const { svc } = service({ fetchVideos })
    svc.set('streamer')
    fetchVideos.mockClear()
    const first = svc.check()
    const second = svc.check()
    resolveFirst(playlist([]))
    await Promise.all([first, second])
    expect(fetchVideos).toHaveBeenCalledTimes(1)
  })
})
