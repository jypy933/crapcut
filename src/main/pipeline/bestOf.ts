// Best-of builder: joins a job's kept clips into one 16:9 video with short
// crossfades, for a single YouTube-ready upload. Every kept clip is rendered
// fresh, exactly like a normal 16:9 export (same captions, audio and encoder
// choice), then joined -- so the result always matches what review shows.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildBestOfArgs, DEFAULT_CROSSFADE_SEC, keptClipsInOrder, planBestOfJoin, type BestOfClipInput } from '../core/bestOf'
import { EtaEstimator } from '../core/eta'
import type { EncoderId } from '../core/render'
import { parseProgressSeconds } from '../core/render'
import { jobDir, type AppPaths } from '../paths'
import type { Store } from '../store'
import { runTool } from '../tools/process'
import type { ToolRegistry } from '../tools/registry'
import { isCancelled, UserError, userMessage } from '../util/errors'
import { moveFile } from '../util/fsx'
import { logger } from '../util/log'
import { safeFileName, type Exporter } from './exporter'
import type { GpuLock } from './gpuLock'
import { probeMedia } from './media'
import { loadMeta } from './steps'
import type { BestOfItem } from '@shared/types'

const log = logger('bestOf')

export { DEFAULT_CROSSFADE_SEC }

/** The kept clips have to overlap by this much or a transition just becomes a hard cut. */
const MIN_CLIP_SEC = 1

export function bestOfFileName(vodTitle: string): string {
  return `Best of - ${safeFileName(vodTitle, 70)} (16x9).mp4`
}

export interface BestOfEvents {
  onChanged: (item: BestOfItem) => void
}

export class BestOfBuilder {
  private queue: string[] = []
  private active: { id: string; controller: AbortController } | null = null
  private progress = new Map<string, { progress: number; etaSec: number | null }>()
  private lastEmit = 0
  private running: Promise<void> | null = null
  private shuttingDown = false

  constructor(
    private readonly store: Store,
    private readonly paths: AppPaths,
    private readonly tools: ToolRegistry,
    /** Reused for per-clip rendering and encoder choice, so both stay in step with normal exports. */
    private readonly exporter: Exporter,
    /** Shared with the exporter so a build and a normal export never encode at the same time. */
    private readonly encodeLock: GpuLock,
    private readonly events: BestOfEvents
  ) {}

  list(jobId?: string): BestOfItem[] {
    return this.store.bestOfList(jobId).map((e) => ({ ...e, ...(this.progress.get(e.id) ?? {}) }))
  }

  private emit(id: string, force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 250) return
    this.lastEmit = now
    const item = this.list().find((e) => e.id === id)
    if (item) this.events.onChanged(item)
  }

  /** True while a build is running or queued (closing the window should not interrupt it). */
  hasWork(): boolean {
    return this.active !== null || this.queue.length > 0
  }

  /** Queues a best-of build for the job's currently kept clips. */
  start(jobId: string): string {
    const kept = keptClipsInOrder(this.store.clips(jobId))
    if (kept.length === 0) throw new UserError('Keep at least one clip first.', { retryable: false })
    for (const c of kept) if (!c.source) throw new UserError('Every kept clip needs its video downloaded first.', { retryable: false })
    // Only one build per job at a time; a new one replaces whatever was queued or running.
    for (const e of this.store.bestOfList(jobId)) if (e.status === 'queued' || e.status === 'running') this.cancel(e.id)
    const id = this.store.addBestOf(jobId)
    this.queue.push(id)
    this.emit(id, true)
    void this.pump()
    return id
  }

  /** Re-queues a build interrupted by a crash or close. */
  resumeQueued(): void {
    for (const e of this.store.bestOfList()) if (e.status === 'queued' && !this.queue.includes(e.id)) this.queue.push(e.id)
    void this.pump()
  }

  cancel(id: string): void {
    const i = this.queue.indexOf(id)
    if (i >= 0) {
      this.queue.splice(i, 1)
      this.store.updateBestOf(id, { status: 'cancelled' })
      this.emit(id, true)
    }
    if (this.active?.id === id) this.active.controller.abort()
  }

  /** Stops the current build; it goes back to the queue for next time. */
  async shutdown(): Promise<void> {
    this.queue = []
    if (this.active) {
      this.shuttingDown = true
      this.active.controller.abort()
    }
    await this.running
  }

  private async pump(): Promise<void> {
    if (this.active || this.shuttingDown) return
    const id = this.queue.shift()
    if (!id) return
    const controller = new AbortController()
    this.active = { id, controller }
    try {
      this.running = this.run(id, controller.signal)
      await this.running
    } finally {
      this.running = null
      this.active = null
      this.progress.delete(id)
      void this.pump()
    }
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const item = this.store.bestOfList().find((e) => e.id === id)
    if (!item) return
    // Stays "queued" (shown as waiting) until the exporter is free -- a full
    // encode never runs at the same time as a normal export.
    let release: (() => void) | null = null
    try {
      release = await this.encodeLock.acquire(signal)
      this.store.updateBestOf(id, { status: 'running', progress: 0, error: null })
      this.emit(id, true)
      const file = await this.build(item.jobId, id, signal, (f, eta) => {
        this.progress.set(id, { progress: f, etaSec: eta })
        this.emit(id)
      })
      this.store.updateBestOf(id, { status: 'done', progress: 1, file })
    } catch (err) {
      if (isCancelled(err)) {
        this.store.updateBestOf(id, { status: this.shuttingDown ? 'queued' : 'cancelled', progress: 0 })
      } else {
        log.error(`best-of ${id.slice(0, 8)} failed`, err)
        this.store.updateBestOf(id, { status: 'failed', error: userMessage(err, 'The best-of video could not be built. Try again.') })
      }
    } finally {
      release?.()
    }
    this.progress.delete(id)
    this.emit(id, true)
  }

  private async build(jobId: string, id: string, signal: AbortSignal, onProgress: (f: number, eta: number | null) => void): Promise<string> {
    const kept = keptClipsInOrder(this.store.clips(jobId))
    if (kept.length === 0) throw new UserError('Keep at least one clip first.', { retryable: false })

    const dir = jobDir(this.paths, jobId)
    const meta = await loadMeta(dir)
    const ffmpeg = this.tools.require('ffmpeg')
    const ffprobe = ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe')

    const work = join(dir, 'render', `bestof-${id}`)
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })

    // Render every kept clip as its own 16:9 export first; the join step only
    // ever sees plain video files it can normalise and stitch together.
    const renderShare = kept.length > 1 ? 0.85 : 1
    const inputs: BestOfClipInput[] = []
    for (let i = 0; i < kept.length; i++) {
      const clip = kept[i]!
      const fileName = `clip-${i}.mp4`
      await this.exporter.renderForBestOf(clip, join(work, `clip-${i}-work`), join(work, fileName), signal, (f) => {
        onProgress(((i + Math.min(1, f)) / kept.length) * renderShare, null)
      })
      const info = await probeMedia(ffprobe, join(work, fileName), signal)
      if (info.duration < MIN_CLIP_SEC) throw new UserError('A kept clip rendered too short to include. Try re-exporting it first.', { retryable: false })
      inputs.push({ file: fileName, duration: info.duration, hasAudio: info.hasAudio })
    }

    const partial = join(work, 'out.mp4')
    const plan = planBestOfJoin(inputs, DEFAULT_CROSSFADE_SEC)
    const eta = new EtaEstimator()

    const joinClips = async (encoder: EncoderId): Promise<void> => {
      const args = buildBestOfArgs(inputs, { crossfadeSec: DEFAULT_CROSSFADE_SEC, encoder, output: 'out.mp4' })
      await runTool(ffmpeg, args, {
        cwd: work,
        signal,
        lowPriority: true,
        onStdout: (line) => {
          const s = parseProgressSeconds(line)
          if (s === null) return
          const f = renderShare + (1 - renderShare) * Math.min(1, s / Math.max(1, plan.totalDurationSec))
          onProgress(f, eta.update(f, 1))
        }
      })
    }

    const encoder = await this.exporter.pickEncoder()
    try {
      await joinClips(encoder)
    } catch (err) {
      if (isCancelled(err) || encoder === 'libx264') throw err
      log.warn(`${encoder} failed for the best-of join; retrying with libx264`, err)
      this.exporter.notifyHwEncoderFailed()
      await joinClips('libx264')
    }

    const outDir = join(this.paths.output, safeFileName(`${meta.vod.channel} - ${meta.vod.title}`, 90))
    mkdirSync(outDir, { recursive: true })
    const final = join(outDir, bestOfFileName(meta.vod.title))
    rmSync(final, { force: true })
    moveFile(partial, final)
    rmSync(work, { recursive: true, force: true })
    log.info(`built best-of for job ${jobId.slice(0, 8)}: ${kept.length} clip(s)`)
    return final
  }
}
