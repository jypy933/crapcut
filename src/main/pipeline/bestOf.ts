// Best-of builder: joins a job's kept clips into one 16:9 video with short
// crossfades, for a single YouTube-ready upload. Every kept clip is prepared
// exactly like a normal 16:9 export (same captions, audio and layout), then
// all of them go through one filter graph into one encode -- so the result
// matches what review shows and no clip is compressed twice.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { buildBestOfRender, buildClipAudioArgs, DEFAULT_CROSSFADE_SEC, keptClipsInOrder, MAX_BEST_OF_CLIPS, type BestOfClip, type BestOfPlan } from '../core/bestOf'
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
import { ensureClipsNormalized } from './clipNormalize'
import { safeFileName, type Exporter } from './exporter'
import type { GpuLock } from './gpuLock'
import { loadMeta } from './steps'
import type { BestOfItem } from '@shared/types'

const log = logger('bestOf')

export { DEFAULT_CROSSFADE_SEC }

/** Windows refuses a command line over 32767 characters; stay well under. */
const MAX_COMMAND_CHARS = 30_000

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
    if (kept.length > MAX_BEST_OF_CLIPS) throw tooManyClips()
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
    const kept = await ensureClipsNormalized(this.store, this.paths, keptClipsInOrder(this.store.clips(jobId)))
    if (kept.length === 0) throw new UserError('Keep at least one clip first.', { retryable: false })
    if (kept.length > MAX_BEST_OF_CLIPS) throw tooManyClips()

    const dir = jobDir(this.paths, jobId)
    const meta = await loadMeta(dir)
    const ffmpeg = this.tools.require('ffmpeg')

    // Scratch files (captions, WAVs, the graph) live here and go when the build ends, however it ends.
    // A restart simply builds again; separated voices and loudness come back from the per-clip cache.
    const work = join(dir, 'render', `bestof-${id}`)
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    try {
      // Everything except the encode, clip by clip: captions, voice separation, loudness, the clip's sound as a lossless WAV.
      const stemClips = kept.filter((c) => c.audio !== 'original').length
      const prepShare = 0.05 + 0.35 * (stemClips / kept.length)
      const clips: BestOfClip[] = []
      for (let i = 0; i < kept.length; i++) {
        const clipWork = `clip-${i}-work`
        const p = await this.exporter.prepareForBestOf(kept[i]!, join(work, clipWork), signal, (f) => {
          onProgress(((i + 0.9 * Math.min(1, f)) / kept.length) * prepShare, null)
        })
        const audioName = `clip-${i}.wav`
        const audioArgs = buildClipAudioArgs({ input: p.input, seek: p.seek, duration: p.duration, audio: p.audio, loudness: p.loudness }, audioName)
        if (audioArgs) await runTool(ffmpeg, audioArgs, { cwd: work, signal, lowPriority: true })
        clips.push({
          input: relativeTo(work, p.input),
          seek: p.seek,
          duration: p.duration,
          source: p.source,
          layout: p.layout,
          assFile: p.assFile ? `${clipWork}/${p.assFile}` : null,
          fontsDir: p.assFile ? `${clipWork}/${p.fontsDir}` : null,
          audioFile: audioArgs ? audioName : null
        })
        onProgress(((i + 1) / kept.length) * prepShare, null)
      }

      // One graph, one encode. The graph goes in a file: twenty clips would overflow the Windows command line.
      const render = (encoder: EncoderId): { args: string[]; graph: string; plan: BestOfPlan } =>
        buildBestOfRender(clips, { crossfadeSec: DEFAULT_CROSSFADE_SEC, encoder, filterScript: 'graph.txt', output: 'out.mp4' })
      const { graph, plan, args: firstArgs } = render('libx264')
      if (firstArgs.join(' ').length > MAX_COMMAND_CHARS) throw tooManyClips()
      writeFileSync(join(work, 'graph.txt'), graph)

      const eta = new EtaEstimator()
      const encode = async (encoder: EncoderId): Promise<void> => {
        await runTool(ffmpeg, render(encoder).args, {
          cwd: work,
          signal,
          lowPriority: true,
          onStdout: (line) => {
            const s = parseProgressSeconds(line)
            if (s === null) return
            const f = prepShare + (1 - prepShare) * Math.min(1, s / Math.max(1, plan.totalDurationSec))
            onProgress(f, eta.update(f, 1))
          }
        })
      }

      const encoder = await this.exporter.pickEncoder()
      try {
        await encode(encoder)
      } catch (err) {
        if (isCancelled(err) || encoder === 'libx264') throw err
        log.warn(`${encoder} failed for the best-of; retrying with libx264`, err)
        this.exporter.notifyHwEncoderFailed()
        await encode('libx264')
      }

      const outDir = join(this.paths.output, safeFileName(`${meta.vod.channel} - ${meta.vod.title}`, 90))
      mkdirSync(outDir, { recursive: true })
      const final = join(outDir, bestOfFileName(meta.vod.title))
      rmSync(final, { force: true })
      moveFile(join(work, 'out.mp4'), final)
      log.info(`built best-of for job ${jobId.slice(0, 8)}: ${kept.length} clip(s)`)
      return final
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}

const tooManyClips = (): UserError => new UserError(`A best-of video holds up to ${MAX_BEST_OF_CLIPS} clips. Keep fewer clips and try again.`, { retryable: false })

/** `file` relative to `dir` with forward slashes (short, and free of the user name); unchanged when it is on another drive. */
function relativeTo(dir: string, file: string): string {
  const rel = relative(dir, file)
  return isAbsolute(rel) ? file : rel.split(sep).join('/')
}
