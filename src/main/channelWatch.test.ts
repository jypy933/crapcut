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

function playlist(entries: { id: string; title?: string; timestamp?: number; is_live?: boolean }[]): string {
  return JSON.stringify({ entries })
}

function service(opts: { fetchVideos?: ReturnType<typeof vi.fn>; isReady?: () => boolean; enqueueJob?: ReturnType<typeof vi.fn> } = {}): {
  svc: ChannelWatchService
  enqueueJob: ReturnType<typeof vi.fn>
  fetchVideos: ReturnType<typeof vi.fn>
} {
  const enqueueJob = opts.enqueueJob ?? vi.fn()
  const fetchVideos = opts.fetchVideos ?? vi.fn().mockResolvedValue(playlist([]))
  const svc = new ChannelWatchService({ store, tools, isReady: opts.isReady ?? (() => true), enqueueJob: enqueueJob as (jobId: string) => void }, fetchVideos as never)
  return { svc, enqueueJob, fetchVideos }
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
    fetchVideos.mockClear()
    await svc.check()
    expect(fetchVideos).not.toHaveBeenCalled()
  })

  it('queues a VOD published after the watch started', async () => {
    const fetchVideos = vi.fn().mockResolvedValue(playlist([{ id: '999', title: 'New stream', timestamp: Math.round((Date.now() + 60_000) / 1000) }]))
    const { svc, enqueueJob } = service({ fetchVideos })
    svc.set('streamer')
    await svc.check()
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    expect(store.findActiveJobForVod('999')).not.toBeNull()
  })

  it('never queues a VOD older than when the watch started', async () => {
    const fetchVideos = vi.fn().mockResolvedValue(playlist([{ id: '111', title: 'Old stream', timestamp: Math.round((Date.now() - 60_000) / 1000) }]))
    const { svc, enqueueJob } = service({ fetchVideos })
    svc.set('streamer')
    await svc.check()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('skips a live VOD', async () => {
    const fetchVideos = vi.fn().mockResolvedValue(playlist([{ id: '222', title: 'Live', timestamp: Math.round((Date.now() + 60_000) / 1000), is_live: true }]))
    const { svc, enqueueJob } = service({ fetchVideos })
    svc.set('streamer')
    await svc.check()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('does not queue the same VOD twice across checks', async () => {
    const future = Math.round((Date.now() + 60_000) / 1000)
    const fetchVideos = vi.fn().mockResolvedValue(playlist([{ id: '333', title: 'New', timestamp: future }]))
    const { svc, enqueueJob } = service({ fetchVideos })
    svc.set('streamer')
    await svc.check()
    await svc.check()
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
    const fetchVideos = vi.fn().mockReturnValueOnce(new Promise<string>((r) => (resolveFirst = r))).mockResolvedValue(playlist([]))
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
