// Watches one channel for new public VODs and queues them through the job
// runner as they appear, so clips are ready without pasting a link. Only
// runs while the app is open: checked a short delay after start, then every
// few hours.

import { parseChannelName } from '@shared/channelName'
import type { ChannelWatch, ChannelWatchStatus } from '@shared/types'
import { newestVodId, parseChannelVideos, selectNewVods, withoutNewest } from './core/channelVideos'
import { fetchChannelIsLive, fetchChannelVideos } from './pipeline/ytdlp'
import type { Store } from './store'
import type { ToolRegistry } from './tools/registry'
import { isCancelled, userMessage } from './util/errors'
import { logger } from './util/log'

const log = logger('channelWatch')

const KV_KEY = 'channelWatch'
const STARTUP_DELAY_MS = 60_000
const CHECK_INTERVAL_MS = 3 * 3600_000

export interface ChannelWatchDeps {
  store: Store
  tools: ToolRegistry
  /** False while setup is still downloading tools. */
  isReady: () => boolean
  enqueueJob: (jobId: string) => void
}

export class ChannelWatchService {
  private checking = false
  private lastCheckedAt: number | null = null
  private lastError: string | null = null
  private listeners = new Set<(s: ChannelWatchStatus) => void>()
  private startupTimer: NodeJS.Timeout | null = null
  private interval: NodeJS.Timeout | null = null
  private controller: AbortController | null = null

  constructor(
    private readonly deps: ChannelWatchDeps,
    /** Overridable in tests; defaults to the real yt-dlp calls. */
    private readonly fetchVideos: typeof fetchChannelVideos = fetchChannelVideos,
    private readonly fetchIsLive: typeof fetchChannelIsLive = fetchChannelIsLive
  ) {}

  onChange(fn: (s: ChannelWatchStatus) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    const s = this.status()
    for (const fn of this.listeners) fn(s)
  }

  status(): ChannelWatchStatus {
    const watch = this.deps.store.get<ChannelWatch>(KV_KEY)
    return {
      channel: watch?.channel ?? null,
      enabledAt: watch?.enabledAt ?? null,
      checking: this.checking,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError
    }
  }

  /** Sets the one watched channel. From now on, only its new VODs are queued. */
  set(input: string): { ok: true; channel: string } | { ok: false; reason: string } {
    const parsed = parseChannelName(input)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    // No baseline yet: the next successful check records the newest VOD id
    // it sees as the baseline and queues nothing, so history is never
    // back-filled, then later checks queue anything newer than that.
    const watch: ChannelWatch = { channel: parsed.channel, enabledAt: Date.now(), baselineId: null }
    this.deps.store.set(KV_KEY, watch)
    this.lastError = null
    this.lastCheckedAt = null
    this.emit()
    return { ok: true, channel: parsed.channel }
  }

  clear(): void {
    this.deps.store.set(KV_KEY, null)
    this.controller?.abort()
    this.lastError = null
    this.lastCheckedAt = null
    this.emit()
  }

  /** Starts the "check at start, then every few hours" schedule. */
  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      void this.check()
      this.interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    }, STARTUP_DELAY_MS)
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.interval) clearInterval(this.interval)
    this.startupTimer = null
    this.interval = null
    this.controller?.abort()
  }

  /** Looks for new VODs now. Safe to call any time; only one check runs at once. */
  async check(): Promise<void> {
    if (this.checking) return
    const watch = this.deps.store.get<ChannelWatch>(KV_KEY)
    if (!watch || !this.deps.isReady()) return
    const ytdlp = this.deps.tools.path('yt-dlp')
    if (!ytdlp) return

    this.checking = true
    this.emit()
    this.controller = new AbortController()
    try {
      const json = await this.fetchVideos(ytdlp, watch.channel, this.controller.signal)
      const vods = parseChannelVideos(json)

      if (watch.baselineId === null) {
        // First successful check since the watch was turned on (or since it
        // was set, if the very first attempt failed): nothing is "new" yet,
        // this just anchors the point history is never back-filled past.
        this.deps.store.set(KV_KEY, { ...watch, baselineId: newestVodId(vods) })
      } else {
        let fresh = selectNewVods(vods, watch.baselineId, (vodId) => !!this.deps.store.findActiveJobForVod(vodId))
        if (fresh.length > 0 && (await this.fetchIsLive(ytdlp, watch.channel, this.controller.signal))) {
          // The channel is live: its newest archive entry is the in-progress
          // stream, still growing. Hold it back until it is no longer live.
          fresh = withoutNewest(fresh)
        }
        for (const v of fresh) {
          const jobId = this.deps.store.createJob(`https://www.twitch.tv/videos/${v.id}`, v.id)
          this.deps.enqueueJob(jobId)
          log.info(`queued ${watch.channel} VOD ${v.id} from the watch`)
        }
      }
      this.lastError = null
    } catch (err) {
      if (!isCancelled(err)) {
        log.error(`channel watch check failed for ${watch.channel}`, err)
        this.lastError = userMessage(err, `Could not check ${watch.channel} for new VODs.`)
      }
    } finally {
      this.checking = false
      this.controller = null
      this.lastCheckedAt = Date.now()
      this.emit()
    }
  }
}
